import * as lark from "@larksuiteoapi/node-sdk";
import type { Logger } from "./log.js";
import { parseReceive, parseRecall, summarizeContent } from "./parse.js";
import type { Channel, ChannelHandlers, ContextLine, SenderType } from "./types.js";

const RECALLED = 230110;

export class FeishuChannel implements Channel {
  readonly name = "feishu" as const;
  private resolvedBotOpenId: string;
  private ws: lark.WSClient | null = null;
  private readonly client: lark.Client;
  private readonly chatNames = new Map<string, { name?: string; at: number }>();

  constructor(
    private readonly opts: {
      appId: string;
      appSecret: string;
      domain: "feishu" | "lark";
      botOpenId?: string;
      log: Logger;
    },
  ) {
    const domain = opts.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    this.client = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      appType: lark.AppType.SelfBuild,
      domain,
    });
    this.resolvedBotOpenId = opts.botOpenId ?? "";
  }

  get botOpenId(): string {
    return this.resolvedBotOpenId;
  }

  async start(handlers: ChannelHandlers): Promise<void> {
    if (!this.resolvedBotOpenId) {
      this.resolvedBotOpenId = await this.fetchBotOpenId();
    }
    const dispatcher = new lark.EventDispatcher({}).register({
      // Feishu acks only after this handler settles, and redelivers past ~3s.
      // Parsing is synchronous; the bridge must not return a promise here.
      "im.message.receive_v1": (data: unknown) => {
        try {
          const parsed = parseReceive(data, this.resolvedBotOpenId);
          if (!parsed.ok) {
            this.opts.log.warn(`ignored feishu event: ${parsed.error}`);
            return;
          }
          handlers.onMessage(parsed.message);
        } catch (error) {
          this.opts.log.error(`inbound handler failed: ${cleanError(error)}`);
        }
      },
      "im.message.recalled_v1": (data: unknown) => {
        const messageId = parseRecall(data);
        if (messageId) handlers.onRecall(messageId);
      },
    });
    this.ws = new lark.WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain: this.opts.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
    });
    await this.ws.start({ eventDispatcher: dispatcher });
    this.opts.log.info("feishu long connection starting");
  }

  async stop(): Promise<void> {
    this.ws?.close({ force: true });
    this.ws = null;
  }

  async reply(input: {
    messageId: string;
    text: string;
    uuid: string;
    inThread: boolean;
  }): Promise<{ messageId: string }> {
    return this.guard(async () => {
      const result = await this.client.im.v1.message.reply({
        path: { message_id: input.messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: input.text }),
          uuid: input.uuid,
          ...(input.inThread ? { reply_in_thread: true } : {}),
        },
      });
      return { messageId: messageIdFrom(result) };
    });
  }

  async send(input: { to: string; text: string; uuid: string }): Promise<{ messageId: string }> {
    const receiveIdType = input.to.startsWith("oc_") ? "chat_id" : "open_id";
    return this.guard(async () => {
      const result = await this.client.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: input.to,
          msg_type: "text",
          content: JSON.stringify({ text: input.text }),
          uuid: input.uuid,
        },
      });
      return { messageId: messageIdFrom(result) };
    });
  }

  async react(input: { messageId: string; emoji: string }): Promise<void> {
    await this.guard(async () => {
      const result = await this.client.im.v1.messageReaction.create({
        path: { message_id: input.messageId },
        data: { reaction_type: { emoji_type: input.emoji } },
      });
      if (result.code && result.code !== 0) throw new Error(`feishu ${result.code}`);
    });
  }

  async isRecalled(messageId: string): Promise<boolean> {
    try {
      const result = await this.client.im.v1.message.get({ path: { message_id: messageId } });
      if (result.code === RECALLED) return true;
      return (result.data?.items ?? []).some((item) => item.deleted === true);
    } catch (error) {
      if (feishuCode(error) === RECALLED) return true;
      throw new Error(cleanError(error));
    }
  }

  async recentContext(input: {
    chatId: string;
    threadId?: string;
    limit: number;
    skipMessageIds: ReadonlySet<string>;
  }): Promise<ContextLine[]> {
    return this.guard(async () => {
      const result = await this.client.im.v1.message.list({
        params: {
          container_id_type: input.threadId ? "thread" : "chat",
          container_id: input.threadId ?? input.chatId,
          sort_type: "ByCreateTimeDesc",
          page_size: input.limit,
        },
      });
      if (result.code && result.code !== 0) throw new Error(`feishu ${result.code}`);
      const items = result.data?.items ?? [];
      const lines: ContextLine[] = [];
      for (const item of items) {
        if (!item.message_id || item.deleted) continue;
        if (input.skipMessageIds.has(item.message_id)) continue;
        const sender = historySender(item.sender);
        const text = preview(item.msg_type ?? "text", item.body?.content ?? "");
        lines.push({
          messageId: item.message_id,
          ...(sender ? { senderId: sender.id, senderType: sender.type } : {}),
          text,
          ...(item.create_time ? { timestamp: Number(item.create_time) } : {}),
        });
      }
      lines.reverse();
      return lines.slice(-input.limit);
    });
  }

  async lookupChatName(chatId: string): Promise<string | undefined> {
    const cached = this.chatNames.get(chatId);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.name;
    try {
      const result = await this.client.im.v1.chat.get({ path: { chat_id: chatId } });
      const name = result.data?.name || undefined;
      this.chatNames.set(chatId, { ...(name ? { name } : {}), at: Date.now() });
      return name;
    } catch (error) {
      this.opts.log.warn(`chat name lookup failed: ${cleanError(error)}`);
      this.chatNames.set(chatId, { at: Date.now() });
      return undefined;
    }
  }

  private async fetchBotOpenId(): Promise<string> {
    const body = await this.client.request<{ bot?: { open_id?: string }; code?: number }>({
      url: "/open-apis/bot/v3/info",
      method: "GET",
    });
    const openId = body.bot?.open_id;
    if (!openId) throw new Error("feishu bot/v3/info did not return open_id");
    return openId;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new Error(cleanError(error));
    }
  }
}

function messageIdFrom(result: {
  code?: number;
  msg?: string;
  data?: { message_id?: string };
}): string {
  if (result.code && result.code !== 0) {
    throw new Error(`feishu ${result.code}`);
  }
  const messageId = result.data?.message_id;
  if (!messageId) throw new Error("feishu response missing message_id");
  return messageId;
}

function historySender(
  sender: { id: string; id_type: string; sender_type: string } | undefined,
): { id: string; type: SenderType } | undefined {
  if (!sender?.id) return undefined;
  if (sender.sender_type === "user") {
    if (sender.id_type !== "open_id") return undefined;
    return { id: sender.id, type: "user" };
  }
  if (sender.sender_type === "bot" || sender.sender_type === "app") {
    return { id: sender.id, type: "bot" };
  }
  return undefined;
}

function preview(messageType: string, content: string): string {
  const summary = summarizeContent(messageType, content);
  if (summary.text) return summary.text.slice(0, 1000);
  if (summary.attachments.length === 0) return "";
  return summary.attachments.map((item) => `[${item.type}]`).join(" ");
}

function feishuCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const data = (error as { response?: { data?: { code?: unknown } } }).response?.data;
  return typeof data?.code === "number" ? data.code : undefined;
}

function cleanError(error: unknown): string {
  const code = feishuCode(error);
  if (code !== undefined) return `feishu ${code}`;
  if (
    error instanceof Error &&
    (error.message.startsWith("feishu ") || error.message === "feishu request failed")
  ) {
    return error.message;
  }
  return "feishu request failed";
}
