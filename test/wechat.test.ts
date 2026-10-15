import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Bridge } from "../src/bridge.js";
import { parseConfig, type AppConfig } from "../src/config.js";
import type { Logger } from "../src/log.js";
import { Store } from "../src/store.js";
import type { InboundMessage } from "../src/types.js";
import { WeChatChannel } from "../src/wechat.js";

const USER = "owner_user@im.wechat";
const BOT = "9fd317d819eb@im.bot";

const quiet: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

test("wechat long poll delivers a finished message and advances the cursor", async () => {
  const dir = tempDir();
  const calls: Array<Record<string, unknown>> = [];
  const seen: InboundMessage[] = [];
  let polls = 0;
  const channel = new WeChatChannel({
    credentialsFile: writeCredentials(dir),
    log: quiet,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/ilink/bot/getupdates");
      const body = bodyOf(init);
      calls.push(body);
      polls += 1;
      if (polls === 1) {
        assert.equal(header(init, "Authorization"), "Bearer test-token");
        assert.equal(header(init, "AuthorizationType"), "ilink_bot_token");
        assert.equal(typeof header(init, "X-WECHAT-UIN"), "string");
        assert.notEqual(header(init, "X-WECHAT-UIN"), "");
        return jsonResponse({
          ret: 0,
          msgs: [
            userMessage({ id: 10, token: "tok-partial", text: "hel", state: 1 }),
            userMessage({ id: 11, token: "tok-a", text: "hello" }),
          ],
          get_updates_buf: "cursor-1",
          longpolling_timeout_ms: 35_000,
        });
      }
      return hang(init?.signal);
    },
  });
  try {
    await channel.start({
      onMessage: (message) => {
        seen.push(message);
      },
      onRecall() {},
    });
    await waitFor(() => calls.length >= 2 && seen.length >= 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.channel, "wechat");
    assert.equal(seen[0]?.text, "hello");
    assert.equal(seen[0]?.sender.id, USER);
    assert.equal(seen[0]?.sender.type, "user");
    assert.equal(seen[0]?.eventId, "wechat:11");
    assert.equal(seen[0]?.chatType, "p2p");
    assert.equal(calls[0]?.get_updates_buf, "");
    assert.equal(calls[1]?.get_updates_buf, "cursor-1");
    const baseInfo = calls[0]?.base_info as { channel_version?: string; bot_agent?: string };
    assert.equal(baseInfo.channel_version, "1.0.0");
    assert.equal(baseInfo.bot_agent, undefined);
    const tokens = readJson(path.join(dir, "context-tokens.json"));
    const entry = tokens[USER] as { context_token?: string; updated_at?: string };
    assert.equal(entry.context_token, "tok-a");
    assert.equal(typeof entry.updated_at, "string");
    const cursor = readJson(path.join(dir, "get-updates-buf.json"));
    assert.equal(cursor.get_updates_buf, "cursor-1");
    assert.equal(fs.statSync(path.join(dir, "context-tokens.json")).mode & 0o777, 0o600);
  } finally {
    await channel.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("send uses the newest persisted context token", async () => {
  const dir = tempDir();
  const seen: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  let polls = 0;
  const channel = new WeChatChannel({
    credentialsFile: writeCredentials(dir),
    ownerUserId: USER,
    log: quiet,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/ilink/bot/getupdates") {
        polls += 1;
        if (polls === 1) {
          return jsonResponse({
            ret: 0,
            msgs: [userMessage({ id: 1, token: "tok-a", text: "first" })],
            get_updates_buf: "c1",
          });
        }
        if (polls === 2) {
          return jsonResponse({
            ret: 0,
            msgs: [userMessage({ id: 2, token: "tok-b", text: "second" })],
            get_updates_buf: "c2",
          });
        }
        return hang(init?.signal);
      }
      assert.equal(url.pathname, "/ilink/bot/sendmessage");
      sent.push(bodyOf(init));
      return jsonResponse({ ret: 0 });
    },
  });
  try {
    await channel.start({
      onMessage: (message) => {
        seen.push(message.text);
      },
      onRecall() {},
    });
    await waitFor(() => seen.length >= 2);
    const sentMessage = await channel.send({ to: USER, text: "pong", uuid: "uuid-1" });
    assert.equal(sentMessage.messageId, "uuid-1");
    assert.equal(sent.length, 1);
    const msg = sent[0]?.msg as {
      context_token?: string;
      to_user_id?: string;
      from_user_id?: string;
      client_id?: string;
      message_type?: number;
      message_state?: number;
      item_list?: Array<{ type?: number; text_item?: { text?: string } }>;
    };
    assert.equal(msg.context_token, "tok-b");
    assert.equal(msg.to_user_id, USER);
    assert.equal(msg.from_user_id, "");
    assert.equal(msg.client_id, "uuid-1");
    assert.equal(msg.message_type, 2);
    assert.equal(msg.message_state, 2);
    assert.equal(msg.item_list?.[0]?.type, 1);
    assert.equal(msg.item_list?.[0]?.text_item?.text, "pong");
    const baseInfo = sent[0]?.base_info as { channel_version?: string; bot_agent?: string };
    assert.equal(baseInfo.channel_version, "1.0.0");
    assert.equal(baseInfo.bot_agent, "grokbot-bridge/0.1.0");
    const tokens = readJson(path.join(dir, "context-tokens.json"));
    const entry = tokens[USER] as { context_token?: string };
    assert.equal(entry.context_token, "tok-b");
  } finally {
    await channel.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing context token is a stable error and does not call iLink", async () => {
  const dir = tempDir();
  const dataDir = path.join(dir, "data");
  writeCredentials(dir);
  let sends = 0;
  const channel = new WeChatChannel({
    credentialsFile: path.join(dir, "credentials.json"),
    ownerUserId: USER,
    log: quiet,
    fetchImpl: async () => {
      sends += 1;
      throw new Error("sendmessage should not be called");
    },
  });
  const store = Store.open(dataDir);
  const bridge = new Bridge(
    appConfig(dir, dataDir, "http://127.0.0.1/unused"),
    store,
    [channel],
    quiet,
  );
  try {
    const missing = await bridge.send(USER, "hi", "uuid-1");
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error, "context_token_expired");
    assert.match(String(missing.body.message), /context_token/);
    const stranger = await bridge.send("stranger@im.wechat", "hi", "uuid-2");
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.error, "target_not_allowed");
    store.stageTrack("evt-9", "9", false, Date.now(), { channel: "wechat", peerId: USER });
    const reply = await bridge.reply("evt-9", "hi", "uuid-3");
    assert.equal(reply.status, 409);
    assert.equal(reply.body.error, "context_token_expired");
    assert.equal(sends, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare failed releases the scope so the next inbound is delivered", async () => {
  const dir = tempDir();
  const dataDir = path.join(dir, "data");
  writeCredentials(dir);
  const posts: WebhookPost[] = [];
  const server = await listenWebhook(posts);
  let polls = 0;
  const sentTokens: string[] = [];
  const channel = new WeChatChannel({
    credentialsFile: path.join(dir, "credentials.json"),
    ownerUserId: USER,
    log: quiet,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/ilink/bot/getupdates") {
        polls += 1;
        if (polls === 1) {
          return jsonResponse({
            ret: 0,
            msgs: [
              userMessage({ id: 1, token: "tok-stale", text: "one" }),
              userMessage({ id: 2, token: "tok-stale", text: "two" }),
            ],
            get_updates_buf: "c1",
          });
        }
        return hang(init?.signal);
      }
      const msg = bodyOf(init).msg as { context_token?: string };
      sentTokens.push(msg.context_token ?? "");
      return jsonResponse({ ret: 2, errmsg: "prepare failed" });
    },
  });
  const store = Store.open(dataDir);
  const bridge = new Bridge(appConfig(dir, dataDir, server.url), store, [channel], quiet);
  try {
    await channel.start({
      onMessage: (message) => bridge.onMessage(message),
      onRecall() {},
    });
    await waitFor(() => awaiting(store, "wechat:2"));
    assert.deepEqual(
      posts[0]?.events.map((event) => event.id),
      ["wechat:1"],
    );
    const reply = await bridge.reply("wechat:1", "answer", "uuid-reply");
    assert.equal(reply.status, 409);
    assert.equal(reply.body.error, "context_token_expired");
    assert.match(String(reply.body.message), /prepare failed/);
    assert.deepEqual(sentTokens, ["tok-stale"]);
    await waitFor(() => posts.length >= 2);
    assert.equal(posts.length, 2);
    assert.deepEqual(
      posts[1]?.events.map((event) => ({ id: event.id, text: event.text })),
      [{ id: "wechat:2", text: "two" }],
    );
    await bridge.noreply("wechat:2");
  } finally {
    await channel.stop();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate wechat message ids are forwarded once", async () => {
  const dir = tempDir();
  const dataDir = path.join(dir, "data");
  writeCredentials(dir);
  const posts: WebhookPost[] = [];
  const server = await listenWebhook(posts);
  let polls = 0;
  const channel = new WeChatChannel({
    credentialsFile: path.join(dir, "credentials.json"),
    ownerUserId: USER,
    log: quiet,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/ilink/bot/getupdates");
      polls += 1;
      if (polls === 1) {
        return jsonResponse({
          ret: 0,
          msgs: [
            userMessage({ id: 1, token: "tok", text: "one" }),
            userMessage({ id: 1, token: "tok", text: "duplicate" }),
            userMessage({ id: 2, token: "tok-2", text: "two" }),
          ],
          get_updates_buf: "c1",
        });
      }
      return hang(init?.signal);
    },
  });
  const store = Store.open(dataDir);
  const bridge = new Bridge(appConfig(dir, dataDir, server.url), store, [channel], quiet);
  try {
    await channel.start({
      onMessage: (message) => bridge.onMessage(message),
      onRecall() {},
    });
    await waitFor(() => awaiting(store, "wechat:2"));
    assert.deepEqual(
      posts[0]?.events.map((event) => event.text),
      ["one"],
    );
    const released = await bridge.noreply("wechat:1");
    assert.equal(released.status, 200);
    await waitFor(() => posts.length >= 2);
    assert.equal(posts.length, 2);
    assert.deepEqual(
      posts[1]?.events.map((event) => event.text),
      ["two"],
    );
    const tokens = readJson(path.join(dir, "context-tokens.json"));
    const entry = tokens[USER] as { context_token?: string };
    assert.equal(entry.context_token, "tok-2");
    await bridge.noreply("wechat:2");
  } finally {
    await channel.stop();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wechat config is optional and iLink ids are checked", () => {
  const previous = {
    FEISHU_APP_ID: process.env.FEISHU_APP_ID,
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
    GROK_ALPHA_KEY: process.env.GROK_ALPHA_KEY,
  };
  process.env.FEISHU_APP_ID = "cli_aaaaaaaaaaaaaaaa";
  process.env.FEISHU_APP_SECRET = "secret";
  process.env.GROK_ALPHA_KEY = "key";
  try {
    const parsed = parseConfig(baseConfig());
    assert.equal(parsed.wechat, undefined);
    assert.throws(
      () => parseConfig({ ...baseConfig(), wechat: { ownerUserId: "ou_nope" } }),
      /wechat\.ownerUserId/,
    );
    assert.throws(
      () =>
        parseConfig({
          ...baseConfig(),
          wechat: { allow: { users: ["ou_person"] } },
        }),
      /iLink id/,
    );
    const homeFile = parseConfig({
      ...baseConfig(),
      wechat: { credentialsFile: "~/weixin-cli/credentials.json", ownerUserId: USER },
    });
    assert.equal(
      homeFile.wechat?.credentialsFile,
      path.join(os.homedir(), "weixin-cli", "credentials.json"),
    );
    assert.equal(homeFile.identity.wechatCredentials, homeFile.wechat?.credentialsFile);
  } finally {
    restoreEnv(previous);
  }
});

function baseConfig(): Record<string, unknown> {
  return {
    feishu: { appIdEnv: "FEISHU_APP_ID", appSecretEnv: "FEISHU_APP_SECRET" },
    ownerOpenId: "ou_owner",
    defaultBot: "alpha",
    bots: {
      alpha: { webhookUrl: "https://example.invalid/hook", webhookKeyEnv: "GROK_ALPHA_KEY" },
    },
  };
}

function appConfig(dir: string, dataDir: string, webhookUrl: string): AppConfig {
  const credentialsFile = path.join(dir, "credentials.json");
  return {
    feishu: { appId: "cli_aaaaaaaaaaaaaaaa", appSecret: "secret", domain: "feishu" },
    ownerOpenId: "ou_owner",
    allow: { users: [], trustedUsers: [], chats: [], trustedBots: [] },
    routes: {},
    defaultBot: "alpha",
    bots: { alpha: { webhookUrl, webhookKey: "key" } },
    http: { host: "127.0.0.1", port: 9 },
    dataDir,
    deliveryTimeoutMs: 60_000,
    maxBotExchanges: 5,
    contextMessages: 0,
    identity: {
      appId: "cli_aaaaaaaaaaaaaaaa",
      appSecret: "secret",
      domain: "feishu",
      botOpenId: "",
      host: "127.0.0.1",
      port: 9,
      token: "",
      dataDir,
      wechatCredentials: credentialsFile,
    },
    wechat: {
      credentialsFile,
      ownerUserId: USER,
      allow: { users: [], trustedUsers: [], trustedBots: [] },
    },
  };
}

function userMessage(input: { id: number; token: string; text: string; state?: number }): unknown {
  return {
    message_id: input.id,
    from_user_id: USER,
    to_user_id: BOT,
    client_id: `client-${input.id}`,
    create_time_ms: 1_700_000_000_000 + input.id,
    message_type: 1,
    message_state: input.state ?? 2,
    context_token: input.token,
    item_list: [{ type: 1, text_item: { text: input.text } }],
  };
}

function writeCredentials(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "credentials.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      bot_token: "test-token",
      ilink_bot_id: BOT,
      ilink_user_id: USER,
      baseurl: "https://ilinkai.weixin.qq.com",
      saved_at: "2026-01-01T00:00:00.000Z",
    }),
  );
  return file;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grokbot-wechat-"));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) return undefined;
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (!signal) {
      reject(new Error("missing abort signal"));
      return;
    }
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function awaiting(store: Store, pendingId: string): boolean {
  return Object.values(store.queues()).some(
    (row) =>
      row.awaiting && row.pending.some((event) => isQueuedEvent(event) && event.id === pendingId),
  );
}

function isQueuedEvent(value: unknown): value is { id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 2000) throw new Error("timed out waiting for wechat test condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface WebhookPost {
  events: Array<{ id: string; text: string }>;
}

function listenWebhook(posts: WebhookPost[]): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      posts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as WebhookPost);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
