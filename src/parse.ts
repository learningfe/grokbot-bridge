import type { Attachment, InboundMessage, Mention, SenderType } from "./types.js";

export type ParseResult = { ok: true; message: InboundMessage } | { ok: false; error: string };

interface RawMention {
  key?: unknown;
  name?: unknown;
  mentioned_type?: unknown;
  id?: { open_id?: unknown };
}

/**
 * Read a Feishu im.message.receive_v1 payload (header fields already flattened
 * onto the object by the SDK). Identity is sender.sender_id.open_id and
 * sender.sender_type. user_id, union_id, display names, and message text
 * are not identity.
 */
export function parseReceive(data: unknown, botOpenId: string): ParseResult {
  if (typeof data !== "object" || data === null) return { ok: false, error: "empty event" };
  const raw = data as Record<string, unknown>;
  const sender = asRecord(raw.sender);
  const message = asRecord(raw.message);
  if (!sender || !message) return { ok: false, error: "missing sender or message" };

  const senderId = readString(asRecord(sender.sender_id)?.open_id);
  const senderType = senderTypeOf(sender.sender_type);
  if (!senderId || !senderType) {
    return { ok: false, error: "sender open_id or sender_type missing" };
  }

  const messageId = readString(message.message_id);
  const chatId = readString(message.chat_id);
  const chatType =
    message.chat_type === "p2p" ? "p2p" : message.chat_type === "group" ? "group" : undefined;
  if (!messageId || !chatId || !chatType) {
    return { ok: false, error: "message id, chat id, or chat type missing" };
  }

  const eventId = readString(raw.event_id) ?? messageId;
  const senderName = readString(sender.name);
  const mentions = readMentions(message.mentions);
  const messageType = readString(message.message_type) ?? "text";
  const summarized = summarizeContent(messageType, readString(message.content) ?? "");
  const threadId = readString(message.thread_id);
  const parentId = readString(message.parent_id);
  const timestamp = Number(readString(message.create_time) ?? readString(raw.create_time) ?? "0");

  const inbound: InboundMessage = {
    eventId,
    messageId,
    channel: "feishu",
    chatId,
    chatType,
    sender: {
      id: senderId,
      type: senderType,
      ...(senderName ? { name: senderName } : {}),
    },
    text: applyMentionLabels(summarized.text, mentions),
    mentions,
    mentionedBot: mentionsBot(mentions, botOpenId),
    ...(parentId ? { replyToMessageId: parentId } : {}),
    ...(threadId ? { threadId } : {}),
    attachments: summarized.attachments,
    messageType,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
  };
  return { ok: true, message: inbound };
}

export function parseRecall(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const raw = data as Record<string, unknown>;
  return readString(raw.message_id);
}

export function mentionsBot(mentions: readonly Mention[], botOpenId: string): boolean {
  for (const mention of mentions) {
    if (mention.key === "@_all") return true;
    if (botOpenId !== "" && mention.id === botOpenId) return true;
  }
  return false;
}

export function summarizeContent(
  messageType: string,
  content: string,
): { text: string; attachments: Attachment[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return { text: content, attachments: [] };
  }
  if (messageType === "text") {
    const text = readString(asRecord(parsed)?.text) ?? "";
    return { text, attachments: [] };
  }
  if (messageType === "image" || messageType === "sticker") {
    const key = readString(asRecord(parsed)?.image_key) ?? readString(asRecord(parsed)?.file_key);
    return { text: "", attachments: [{ type: messageType, ...(key ? { key } : {}) }] };
  }
  if (messageType === "file" || messageType === "audio" || messageType === "media") {
    const record = asRecord(parsed);
    const key = readString(record?.file_key);
    const name = readString(record?.file_name);
    return {
      text: "",
      attachments: [{ type: messageType, ...(key ? { key } : {}), ...(name ? { name } : {}) }],
    };
  }
  if (messageType === "post") {
    return summarizePost(parsed);
  }
  return { text: "", attachments: [{ type: messageType }] };
}

function summarizePost(parsed: unknown): { text: string; attachments: Attachment[] } {
  const root = asRecord(parsed);
  const localized = root ? (asRecord(root.zh_cn) ?? asRecord(root.en_us) ?? root) : undefined;
  const title = readString(localized?.title) ?? "";
  const blocks = Array.isArray(localized?.content) ? localized.content : [];
  const parts: string[] = [];
  if (title) parts.push(title);
  const attachments: Attachment[] = [];
  for (const row of blocks) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      const item = asRecord(cell);
      if (!item) continue;
      const tag = readString(item.tag);
      if (tag === "text" || tag === "a") {
        const text = readString(item.text);
        if (text) parts.push(text);
      } else if (tag === "at") {
        const name = readString(item.user_name);
        if (name) parts.push(`@${name}`);
      } else if (tag === "img" || tag === "media" || tag === "file") {
        const key = readString(item.image_key) ?? readString(item.file_key);
        attachments.push({ type: tag, ...(key ? { key } : {}) });
      }
    }
  }
  return { text: parts.join(""), attachments };
}

function readMentions(value: unknown): Mention[] {
  if (!Array.isArray(value)) return [];
  const mentions: Mention[] = [];
  for (const item of value) {
    const mention = item as RawMention;
    const id = readString(mention.id?.open_id);
    const key = readString(mention.key);
    if (!id && key !== "@_all") continue;
    const name = readString(mention.name);
    mentions.push({
      id: id ?? "",
      type: mention.mentioned_type === "bot" ? "bot" : "user",
      ...(key ? { key } : {}),
      ...(name ? { name } : {}),
    });
  }
  return mentions;
}

function applyMentionLabels(text: string, mentions: readonly Mention[]): string {
  let out = text;
  for (const mention of mentions) {
    if (!mention.key) continue;
    const label = mention.name ? `@${mention.name}` : mention.key;
    out = out.split(mention.key).join(label);
  }
  return out;
}

function senderTypeOf(value: unknown): SenderType | undefined {
  if (value === "user") return "user";
  if (value === "bot") return "bot";
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
