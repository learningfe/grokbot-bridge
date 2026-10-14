import type { AppConfig } from "./config.js";
import { postJson, withTimeout } from "./delivery.js";
import { acceptInbound, inConversation } from "./filter.js";
import type { ApiResult } from "./http-api.js";
import type { Logger } from "./log.js";
import { nextLoop } from "./loop-guard.js";
import { scopeKey, resolveBot } from "./routing.js";
import { ScopeQueue, type QueueSnapshotT } from "./scope-queue.js";
import { checkSendTarget } from "./send-guard.js";
import type { Store } from "./store.js";
import { resolveTrust, type TrustPolicy } from "./trust.js";
import type {
  Channel,
  ContextLine,
  InboundMessage,
  NormalizedEvent,
  Sender,
  WebhookBody,
  WebhookContextLine,
} from "./types.js";
import { feishuUuid } from "./uuid.js";

const RECALLED_ERROR = "feishu 230110";

export class Bridge {
  private readonly queue: ScopeQueue<NormalizedEvent>;

  constructor(
    private config: AppConfig,
    private readonly store: Store,
    private readonly channel: Channel,
    private readonly log: Logger,
  ) {
    this.queue = new ScopeQueue({
      deliver: (batch) => this.deliver(batch.scope, batch.events),
      timeoutMs: () => this.config.deliveryTimeoutMs,
      onTimeout: (scope, eventIds) => {
        this.log.warn(
          `scope ${scope} timed out waiting for the bot; releasing the queue`,
          eventIds,
        );
      },
      onDeliveryError: (scope, eventIds, error) => {
        this.log.error(`scope ${scope} delivery failed: ${cleanError(error)}`, eventIds);
      },
      onChange: () => {
        this.store.saveQueues(this.queue.snapshot());
      },
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(timer) };
      },
    });
  }

  replaceConfig(config: AppConfig): void {
    this.config = config;
  }

  restore(): void {
    const saved = this.store.queues();
    const clean: QueueSnapshotT<NormalizedEvent> = {};
    for (const [scope, row] of Object.entries(saved)) {
      const pending = Array.isArray(row.pending) ? row.pending.filter(isEvent) : [];
      const inflight = Array.isArray(row.inflight) ? row.inflight.filter(isEvent) : null;
      if (pending.length === 0 && (!inflight || inflight.length === 0)) continue;
      clean[scope] = {
        inflight,
        awaiting: row.awaiting === true,
        startedAt: typeof row.startedAt === "number" ? row.startedAt : 0,
        pending,
      };
    }
    this.queue.restore(clean);
  }

  onMessage(incoming: InboundMessage): void {
    const ids =
      incoming.eventId === incoming.messageId
        ? [incoming.eventId]
        : [incoming.eventId, incoming.messageId];
    if (ids.some((id) => this.store.hasSeen(id))) return;

    const trust = resolveTrust(incoming.sender, this.trustPolicy());
    const repliesToBot = incoming.replyToMessageId
      ? this.store.wasSent(incoming.replyToMessageId)
      : false;
    const scope = scopeKey({
      chatType: incoming.chatType,
      senderId: incoming.sender.id,
      chatId: incoming.chatId,
      ...(incoming.threadId ? { threadId: incoming.threadId } : {}),
    });
    const gate = {
      chatType: incoming.chatType,
      chatId: incoming.chatId,
      senderId: incoming.sender.id,
      selfBotId: this.channel.botOpenId,
      trust,
      mentionedBot: incoming.mentionedBot,
      repliesToBot,
      allowedChats: new Set(this.config.allow.chats),
    };
    if (!inConversation(gate)) {
      this.store.claimSeen(ids);
      this.log.info(`dropped ${incoming.eventId} scope=${scope} trust=${trust}`);
      return;
    }
    if (!acceptInbound(gate)) {
      if (!this.store.stageSeen(ids)) return;
      // A person speaking in the chat ends a bot-to-bot pause even when
      // the message itself is not forwarded (no @, not a reply to us).
      if (incoming.sender.type === "user") this.store.stageLoop(scope, 0);
      this.store.flush();
      this.log.info(`dropped ${incoming.eventId} scope=${scope} trust=${trust}`);
      return;
    }

    const decision = nextLoop(
      this.store.loopCount(scope),
      incoming.sender.type,
      this.config.maxBotExchanges,
    );
    if (!decision.forward) {
      if (!this.store.stageSeen(ids)) return;
      this.store.stageLoop(scope, decision.count);
      this.store.flush();
      this.log.warn(`bot-to-bot limit reached in ${scope}`);
      if (decision.notifyOwner) void this.notifyOwner(scope);
      return;
    }

    if (!this.store.stageSeen(ids)) return;
    const event = toEvent(incoming, scope, trust, repliesToBot);
    this.store.stageTrack(event.id, event.messageId, Boolean(event.threadId));
    this.store.stageLoop(scope, decision.count);
    this.queue.enqueue(scope, event);
  }

  onRecall(messageId: string): void {
    this.store.markRecalled(messageId);
    this.log.info(`message recalled ${messageId}`);
  }

  async reply(eventId: string, text: string, uuid: string): Promise<ApiResult> {
    const tracked = this.store.tracked(eventId);
    if (!tracked) return unknownEvent();
    if (await this.recalled(tracked.messageId)) {
      this.queue.complete(eventId);
      return { status: 200, body: { ok: true, skipped: "recalled" } };
    }
    try {
      const sent = await this.channel.reply({
        messageId: tracked.messageId,
        text,
        uuid,
        inThread: tracked.inThread,
      });
      this.store.markSent(sent.messageId);
      const released = this.queue.complete(eventId);
      return { status: 200, body: { ok: true, messageId: sent.messageId, late: !released } };
    } catch (error) {
      if (cleanError(error) === RECALLED_ERROR) {
        this.store.markRecalled(tracked.messageId);
        this.queue.complete(eventId);
        return { status: 200, body: { ok: true, skipped: "recalled" } };
      }
      this.log.error(`reply failed for ${eventId}: ${cleanError(error)}`);
      return { status: 502, body: { ok: false, error: "send_failed", message: cleanError(error) } };
    }
  }

  async noreply(eventId: string): Promise<ApiResult> {
    if (!this.store.tracked(eventId)) return unknownEvent();
    const released = this.queue.complete(eventId);
    return { status: 200, body: { ok: true, late: !released } };
  }

  async send(to: string, text: string, uuid: string): Promise<ApiResult> {
    const check = checkSendTarget(to, {
      ownerId: this.config.ownerOpenId,
      users: new Set(this.config.allow.users),
      trustedUsers: new Set(this.config.allow.trustedUsers),
      trustedBots: new Set(this.config.allow.trustedBots),
      chats: new Set(this.config.allow.chats),
    });
    if (!check.ok) {
      return {
        status: 403,
        body: { ok: false, error: "target_not_allowed", message: check.message },
      };
    }
    try {
      const sent = await this.channel.send({ to, text, uuid });
      this.store.markSent(sent.messageId);
      return { status: 200, body: { ok: true, messageId: sent.messageId } };
    } catch (error) {
      this.log.error(`send failed: ${cleanError(error)}`);
      return { status: 502, body: { ok: false, error: "send_failed", message: cleanError(error) } };
    }
  }

  async react(messageId: string, emoji: string): Promise<ApiResult> {
    try {
      await this.channel.react({ messageId, emoji });
      return { status: 200, body: { ok: true } };
    } catch (error) {
      this.log.error(`react failed: ${cleanError(error)}`);
      return { status: 502, body: { ok: false, error: "send_failed", message: cleanError(error) } };
    }
  }

  private async deliver(scope: string, events: NormalizedEvent[]): Promise<void> {
    const first = events[0];
    if (!first) return;
    const botName = resolveBot(scope, first.chatId, this.config.routes, this.config.defaultBot);
    const bot = this.config.bots[botName];
    if (!bot) throw new Error(`no webhook configured for bot ${botName}`);
    const chatName = await this.chatName(first.chatId);
    const bodyEvents = chatName ? events.map((event) => ({ ...event, chatName })) : events;
    const recentContext = await this.context(first, events);
    const body: WebhookBody = { scope, bot: botName, events: bodyEvents, recentContext };
    await postJson(bot.webhookUrl, bot.webhookKey, body);
    this.log.info(
      `delivered ${events.length} event(s) in ${scope} to ${botName}`,
      events.map((event) => event.id),
    );
  }

  private async context(
    first: NormalizedEvent,
    events: NormalizedEvent[],
  ): Promise<WebhookContextLine[]> {
    if (this.config.contextMessages === 0) return [];
    try {
      const lines = await withTimeout(
        this.channel.recentContext({
          chatId: first.chatId,
          ...(first.threadId ? { threadId: first.threadId } : {}),
          limit: this.config.contextMessages,
          skipMessageIds: new Set(events.map((event) => event.messageId)),
        }),
        1500,
      );
      return lines.map((line) => ({ ...line, trust: contextTrust(line, this.trustPolicy()) }));
    } catch (error) {
      this.log.warn(`recent context skipped: ${cleanError(error)}`);
      return [];
    }
  }

  private async chatName(chatId: string): Promise<string | undefined> {
    try {
      return await withTimeout(this.channel.lookupChatName(chatId), 1500);
    } catch {
      return undefined;
    }
  }

  private async recalled(messageId: string): Promise<boolean> {
    if (this.store.wasRecalled(messageId)) return true;
    try {
      const recalled = await this.channel.isRecalled(messageId);
      if (recalled) this.store.markRecalled(messageId);
      return recalled;
    } catch (error) {
      throw new Error(cleanError(error));
    }
  }

  private async notifyOwner(scope: string): Promise<void> {
    try {
      await this.channel.send({
        to: this.config.ownerOpenId,
        text: `grokbot-bridge paused bot-to-bot messages in ${scope} until a person speaks there.`,
        uuid: feishuUuid(),
      });
    } catch (error) {
      this.log.error(`owner notification failed: ${cleanError(error)}`);
    }
  }

  private trustPolicy(): TrustPolicy {
    return {
      ownerId: this.config.ownerOpenId,
      trustedUsers: new Set(this.config.allow.trustedUsers),
      allowedUsers: new Set(this.config.allow.users),
      trustedBots: new Set(this.config.allow.trustedBots),
    };
  }
}

function toEvent(
  incoming: InboundMessage,
  scope: string,
  trust: Sender["trust"],
  repliesToBot: boolean,
): NormalizedEvent {
  return {
    id: incoming.eventId,
    messageId: incoming.messageId,
    channel: incoming.channel,
    scope,
    chatId: incoming.chatId,
    chatType: incoming.chatType,
    ...(incoming.threadId ? { threadId: incoming.threadId } : {}),
    sender: {
      id: incoming.sender.id,
      type: incoming.sender.type,
      ...(incoming.sender.name ? { name: incoming.sender.name } : {}),
      trust,
    },
    text: incoming.text,
    mentions: incoming.mentions,
    ...(incoming.replyToMessageId ? { replyToMessageId: incoming.replyToMessageId } : {}),
    repliesToBot,
    attachments: incoming.attachments,
    messageType: incoming.messageType,
    timestamp: incoming.timestamp,
  };
}

function contextTrust(line: ContextLine, policy: TrustPolicy): Sender["trust"] {
  if (!line.senderId || !line.senderType) return "unknown";
  if (line.senderType === "bot" && !line.senderId.startsWith("ou_")) return "unknown";
  return resolveTrust({ id: line.senderId, type: line.senderType }, policy);
}

function isEvent(value: unknown): value is NormalizedEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<NormalizedEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.messageId === "string" &&
    typeof event.scope === "string" &&
    typeof event.chatId === "string" &&
    event.sender !== undefined &&
    typeof event.sender === "object"
  );
}

function unknownEvent(): ApiResult {
  return { status: 404, body: { ok: false, error: "unknown_event" } };
}

function cleanError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("feishu ")) return error.message;
  if (error instanceof Error && error.message.startsWith("webhook ")) return error.message;
  if (error instanceof Error && error.message.startsWith("no webhook")) return error.message;
  return "request failed";
}
