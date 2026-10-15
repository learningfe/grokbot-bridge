import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "./log.js";
import type { Attachment, Channel, ChannelHandlers, ContextLine, InboundMessage } from "./types.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.0";
const BOT_AGENT = "grokbot-bridge/0.1.0";
const TEXT_CHUNK_LIMIT = 2000;
const DEFAULT_POLL_MS = 35_000;
const POLL_GRACE_MS = 5_000;

export const CONTEXT_TOKEN_EXPIRED = "context_token_expired";
export const SESSION_EXPIRED = "session_expired";

const EXPIRED_TOKEN_MESSAGE =
  "WeChat context_token is missing or expired. The user must send a WeChat message before another send can land. Notify them in the app instead of retrying this send.";

export type WechatErrorCode =
  "context_token_expired" | "session_expired" | "unsupported" | "wechat_failed";

export class WechatError extends Error {
  readonly code: WechatErrorCode;

  constructor(code: WechatErrorCode, message: string) {
    super(message);
    this.name = "WechatError";
    this.code = code;
  }
}

interface Credentials {
  botToken: string;
  botId: string;
  userId?: string;
  baseUrl: string;
}

interface TokenEntry {
  context_token: string;
  updated_at: string;
}

/**
 * Same file weixin-cli reads: `{ [userId]: { context_token, updated_at } }`.
 * The getupdates cursor lives in a sibling file so token list stays user entries only.
 */
export class WeChatChannel implements Channel {
  readonly name = "wechat" as const;
  readonly botOpenId: string;
  readonly ownerUserId: string;
  private readonly botToken: string;
  private readonly baseUrl: string;
  private readonly configDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private stopController = new AbortController();
  private running: Promise<void> = Promise.resolve();
  private pollTimeoutMs = DEFAULT_POLL_MS;
  private stopped = true;
  private failures = 0;

  constructor(opts: {
    credentialsFile: string;
    ownerUserId?: string;
    log: Logger;
    fetchImpl?: typeof fetch;
  }) {
    const creds = loadCredentials(opts.credentialsFile);
    this.botOpenId = creds.botId;
    this.botToken = creds.botToken;
    this.baseUrl = creds.baseUrl;
    this.configDir = path.dirname(path.resolve(opts.credentialsFile));
    const owner = opts.ownerUserId || creds.userId || "";
    if (!owner.endsWith("@im.wechat")) {
      throw new Error(
        "wechat owner is unset; set wechat.ownerUserId or ilink_user_id in the credentials file",
      );
    }
    this.ownerUserId = owner;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log;
  }

  async start(handlers: ChannelHandlers): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.failures = 0;
    this.stopController = new AbortController();
    this.log.info(`wechat long poll starting for ${this.botOpenId}`);
    this.running = this.pollLoop(handlers);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopController.abort();
    await this.running;
  }

  async reply(input: {
    messageId: string;
    text: string;
    uuid: string;
    inThread: boolean;
    to?: string;
  }): Promise<{ messageId: string }> {
    if (!input.to) {
      throw new WechatError("wechat_failed", "wechat reply is missing the user id");
    }
    return this.send({ to: input.to, text: input.text, uuid: input.uuid });
  }

  async send(input: { to: string; text: string; uuid: string }): Promise<{ messageId: string }> {
    // Read at send time. An inbound that arrived while the bot was thinking
    // must win over the token captured with the original event. Do not write
    // this token back: a send must not clobber a newer inbound token.
    const contextToken = readContextToken(this.configDir, input.to);
    if (!contextToken) throw new WechatError("context_token_expired", EXPIRED_TOKEN_MESSAGE);
    const chunks = chunkText(input.text);
    let messageId = input.uuid;
    for (let index = 0; index < chunks.length; index++) {
      const text = chunks[index];
      if (text === undefined) continue;
      const clientId = index === 0 ? input.uuid : newClientId();
      await this.sendChunk(input.to, text, contextToken, clientId);
      if (index === 0) messageId = clientId;
    }
    return { messageId };
  }

  async react(): Promise<void> {
    throw new WechatError("unsupported", "wechat unsupported: reactions");
  }

  async isRecalled(): Promise<boolean> {
    return false;
  }

  async recentContext(): Promise<ContextLine[]> {
    return [];
  }

  async lookupChatName(): Promise<string | undefined> {
    return undefined;
  }

  private async sendChunk(
    toUserId: string,
    text: string,
    contextToken: string,
    clientId: string,
  ): Promise<void> {
    const data = await this.post("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
    });
    if (isSessionExpired(data)) {
      throw new WechatError(
        "session_expired",
        "WeChat session expired (ret=-14). Run `weixin-cli login` on this machine.",
      );
    }
    if (isContextTokenFailure(data)) {
      const errmsg = typeof data.errmsg === "string" ? data.errmsg : "prepare failed";
      throw new WechatError("context_token_expired", `${EXPIRED_TOKEN_MESSAGE} (${errmsg})`);
    }
    if (typeof data.ret === "number" && data.ret !== 0) {
      throw new WechatError(
        "wechat_failed",
        `wechat sendmessage ret=${data.ret} errmsg=${typeof data.errmsg === "string" ? data.errmsg : "(none)"}`,
      );
    }
  }

  private async pollLoop(handlers: ChannelHandlers): Promise<void> {
    while (!this.stopped) {
      try {
        const result = await this.pollOnce(handlers);
        if (this.stopped) return;
        this.failures = 0;
        if (result === "session_expired") {
          // A new login issues a new cursor. Keep context tokens; the next
          // inbound overwrites them, and there is no refresh API.
          writeCursor(this.configDir, "");
          this.log.error("wechat session expired (ret=-14); run weixin-cli login");
          await this.sleep(30_000);
        }
      } catch (error) {
        if (this.stopped) return;
        this.failures += 1;
        const wait = this.failures >= 3 ? 30_000 : 2_000;
        const message = error instanceof Error ? error.message : "failed";
        this.log.warn(`wechat getupdates failed: ${message}`);
        await this.sleep(wait);
      }
    }
  }

  private async pollOnce(handlers: ChannelHandlers): Promise<"ok" | "session_expired"> {
    const timeout = cancelableTimeout(this.pollTimeoutMs + POLL_GRACE_MS);
    const signal = AbortSignal.any([this.stopController.signal, timeout.signal]);
    try {
      const cursor = readCursor(this.configDir);
      const data = await this.post(
        "ilink/bot/getupdates",
        {
          get_updates_buf: cursor,
          base_info: { channel_version: CHANNEL_VERSION },
        },
        signal,
      );
      if (this.stopped) return "ok";
      if (isSessionExpired(data)) return "session_expired";
      if (typeof data.ret === "number" && data.ret !== 0) {
        const errmsg = typeof data.errmsg === "string" ? data.errmsg : "(none)";
        throw new WechatError(
          "wechat_failed",
          `wechat getupdates ret=${data.ret} errmsg=${errmsg}`,
        );
      }
      const timeoutMs = data.longpolling_timeout_ms;
      if (typeof timeoutMs === "number" && timeoutMs >= 1000 && timeoutMs <= 120_000) {
        this.pollTimeoutMs = timeoutMs;
      }
      const msgs = Array.isArray(data.msgs) ? data.msgs : [];
      for (const msg of msgs) this.consume(msg, handlers);
      if (typeof data.get_updates_buf === "string" && data.get_updates_buf !== "") {
        writeCursor(this.configDir, data.get_updates_buf);
      }
      return "ok";
    } catch (error) {
      if (this.stopped || this.stopController.signal.aborted) throw error;
      // The client timer firing is an empty poll, not a server error.
      if (isAbort(error)) return "ok";
      throw error;
    } finally {
      timeout.cancel();
    }
  }

  private consume(value: unknown, handlers: ChannelHandlers): void {
    if (typeof value !== "object" || value === null) return;
    const msg = value as RawMessage;
    const userId = humanUserId(msg);
    const contextToken = typeof msg.context_token === "string" ? msg.context_token.trim() : "";
    if (userId && contextToken) writeContextToken(this.configDir, userId, contextToken);

    const incoming = toInbound(msg, this.botOpenId);
    if (!incoming) {
      if (msg.message_state === 0 || msg.message_state === 1) {
        const id = platformMessageId(msg);
        this.log.info(
          `wechat skipped non-final message ${id ?? "?"} state=${String(msg.message_state)}`,
        );
      }
      return;
    }
    try {
      handlers.onMessage(incoming);
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed";
      this.log.error(`wechat inbound handler failed: ${message}`);
    }
  }

  private async post(
    apiPath: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}/${apiPath}`, {
      method: "POST",
      headers: authHeaders(this.botToken),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        throw new WechatError(
          "wechat_failed",
          `wechat ${apiPath} returned non-JSON (HTTP ${response.status})`,
        );
      }
    }
    if (!response.ok) {
      throw new WechatError("wechat_failed", `wechat ${apiPath} HTTP ${response.status}`);
    }
    if (typeof data !== "object" || data === null) {
      throw new WechatError("wechat_failed", `wechat ${apiPath} returned a non-object`);
    }
    return data as Record<string, unknown>;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.stopController.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.stopController.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function toInbound(msg: RawMessage, botId: string): InboundMessage | undefined {
  if (typeof msg.group_id === "string" && msg.group_id !== "") return undefined;
  if (typeof msg.delete_time_ms === "number" && msg.delete_time_ms > 0) return undefined;
  if (msg.message_type === 2) return undefined;
  if (msg.from_user_id === botId) return undefined;
  if (typeof msg.from_user_id !== "string" || !msg.from_user_id.endsWith("@im.wechat")) {
    return undefined;
  }
  // GENERATING / NEW updates are partial. Forward only a finished user message
  // so the bot does not answer a half-written text. A missing state is final.
  if (msg.message_state === 0 || msg.message_state === 1) return undefined;

  const messageId = platformMessageId(msg);
  if (!messageId) return undefined;
  const summarized = summarizeItems(msg.item_list);
  const timestamp = typeof msg.create_time_ms === "number" ? msg.create_time_ms : 0;
  return {
    eventId: `wechat:${messageId}`,
    messageId,
    channel: "wechat",
    chatId: msg.from_user_id,
    chatType: "p2p",
    sender: { id: msg.from_user_id, type: "user" },
    text: summarized.text,
    mentions: [],
    mentionedBot: false,
    attachments: summarized.attachments,
    messageType: summarized.messageType,
    timestamp,
  };
}

function platformMessageId(msg: RawMessage): string | undefined {
  if (typeof msg.message_id === "number" && Number.isFinite(msg.message_id)) {
    return String(msg.message_id);
  }
  if (typeof msg.message_id === "string" && msg.message_id.trim() !== "")
    return msg.message_id.trim();
  if (typeof msg.client_id === "string" && msg.client_id.trim() !== "") return msg.client_id.trim();
  return undefined;
}

function humanUserId(msg: RawMessage): string | undefined {
  if (typeof msg.from_user_id === "string" && msg.from_user_id.endsWith("@im.wechat")) {
    return msg.from_user_id;
  }
  if (typeof msg.to_user_id === "string" && msg.to_user_id.endsWith("@im.wechat")) {
    return msg.to_user_id;
  }
  return undefined;
}

function summarizeItems(items: unknown): {
  text: string;
  attachments: Attachment[];
  messageType: string;
} {
  if (!Array.isArray(items)) return { text: "", attachments: [], messageType: "text" };
  const texts: string[] = [];
  const attachments: Attachment[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as RawItem;
    if (row.type === 1 || typeof row.text_item?.text === "string") {
      if (typeof row.text_item?.text === "string" && row.text_item.text !== "") {
        texts.push(row.text_item.text);
      }
      continue;
    }
    const attachment = attachmentOf(row);
    if (attachment) attachments.push(attachment);
  }
  const messageType = texts.length > 0 ? "text" : (attachments[0]?.type ?? "text");
  return { text: texts.join("\n"), attachments, messageType };
}

function attachmentOf(item: RawItem): Attachment | undefined {
  if (item.type === 2) return { type: "image" };
  if (item.type === 3) return { type: "voice" };
  if (item.type === 4) {
    const name = item.file_item?.file_name;
    return typeof name === "string" && name !== "" ? { type: "file", name } : { type: "file" };
  }
  if (item.type === 5) return { type: "video" };
  return undefined;
}

interface RawMessage {
  message_id?: unknown;
  from_user_id?: unknown;
  to_user_id?: unknown;
  client_id?: unknown;
  create_time_ms?: unknown;
  group_id?: unknown;
  message_type?: unknown;
  message_state?: unknown;
  context_token?: unknown;
  delete_time_ms?: unknown;
  item_list?: unknown;
}

interface RawItem {
  type?: unknown;
  text_item?: { text?: unknown };
  file_item?: { file_name?: unknown };
}

function isSessionExpired(data: Record<string, unknown>): boolean {
  return data.ret === -14 || data.errcode === -14;
}

function isContextTokenFailure(data: Record<string, unknown>): boolean {
  const errmsg = typeof data.errmsg === "string" ? data.errmsg : "";
  if (/prepare failed/i.test(errmsg)) return true;
  return /context[_ ]token/i.test(errmsg) && /expir|invalid|stale|not found/i.test(errmsg);
}

function authHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": randomWechatUin(),
  };
}

function randomWechatUin(): string {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function newClientId(): string {
  return `grokbot-bridge:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function chunkText(text: string, limit = TEXT_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    const window = rest.slice(0, limit);
    const para = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    if (para >= limit * 0.5) cut = para + 2;
    else if (line >= limit * 0.5) cut = line + 1;
    else if (space >= limit * 0.5) cut = space + 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function loadCredentials(file: string): Credentials {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`wechat credentials file not found: ${file}`);
    throw new Error(`wechat credentials file unreadable: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`wechat credentials file is not valid JSON: ${file}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`wechat credentials file is not an object: ${file}`);
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.bot_token !== "string" || row.bot_token === "") {
    throw new Error("wechat credentials missing bot_token");
  }
  if (typeof row.ilink_bot_id !== "string" || !row.ilink_bot_id.endsWith("@im.bot")) {
    throw new Error("wechat credentials ilink_bot_id must end with @im.bot");
  }
  const userId = typeof row.ilink_user_id === "string" ? row.ilink_user_id : undefined;
  const base =
    typeof row.baseurl === "string" && row.baseurl !== "" ? row.baseurl : DEFAULT_BASE_URL;
  return {
    botToken: row.bot_token,
    botId: row.ilink_bot_id,
    ...(userId ? { userId } : {}),
    baseUrl: base.replace(/\/+$/, ""),
  };
}

function tokenFile(configDir: string): string {
  return path.join(configDir, "context-tokens.json");
}

function readTokenMap(file: string): Record<string, TokenEntry> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new WechatError("wechat_failed", "wechat context token store is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WechatError("wechat_failed", "wechat context token store is not an object");
  }
  return parsed as Record<string, TokenEntry>;
}

function readContextToken(configDir: string, userId: string): string | undefined {
  const entry = readTokenMap(tokenFile(configDir))[userId];
  if (typeof entry !== "object" || entry === null) return undefined;
  const token = entry.context_token;
  if (typeof token !== "string" || token.trim() === "") return undefined;
  return token;
}

function writeContextToken(configDir: string, userId: string, token: string): void {
  const file = tokenFile(configDir);
  const map = readTokenMap(file);
  map[userId] = { context_token: token, updated_at: new Date().toISOString() };
  writeJson(file, map);
}

function cursorFile(configDir: string): string {
  return path.join(configDir, "get-updates-buf.json");
}

function readCursor(configDir: string): string {
  const file = cursorFile(configDir);
  if (!fs.existsSync(file)) return "";
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return "";
    const buf = (parsed as { get_updates_buf?: unknown }).get_updates_buf;
    return typeof buf === "string" ? buf : "";
  } catch {
    return "";
  }
}

function writeCursor(configDir: string, buf: string): void {
  writeJson(cursorFile(configDir), { get_updates_buf: buf });
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort where chmod is unsupported
  }
}

function isAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function cancelableTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // The poll loop awaits the request. This timer must not keep a finished test alive.
  timer.unref();
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}
