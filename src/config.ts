import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isIlinkId } from "./send-guard.js";

export interface WechatConfig {
  credentialsFile: string;
  /** When omitted, the channel uses ilink_user_id from the credentials file. */
  ownerUserId?: string;
  allow: {
    users: string[];
    trustedUsers: string[];
    trustedBots: string[];
  };
}

export interface AppConfig {
  feishu: {
    appId: string;
    appSecret: string;
    domain: "feishu" | "lark";
    botOpenId?: string;
  };
  wechat?: WechatConfig;
  ownerOpenId: string;
  allow: {
    users: string[];
    trustedUsers: string[];
    chats: string[];
    trustedBots: string[];
  };
  routes: Record<string, string>;
  defaultBot: string;
  bots: Record<string, { webhookUrl: string; webhookKey: string }>;
  http: { host: string; port: number; token?: string };
  dataDir: string;
  deliveryTimeoutMs: number;
  maxBotExchanges: number;
  contextMessages: number;
  /** Values that require a process restart to take effect. */
  identity: {
    appId: string;
    appSecret: string;
    domain: string;
    botOpenId: string;
    host: string;
    port: number;
    token: string;
    dataDir: string;
    wechatCredentials: string;
  };
}

const TOP_KEYS = new Set([
  "feishu",
  "ownerOpenId",
  "allow",
  "routes",
  "defaultBot",
  "bots",
  "http",
  "dataDir",
  "deliveryTimeoutMs",
  "maxBotExchanges",
  "contextMessages",
  "wechat",
]);

export function loadConfig(file: string): AppConfig {
  const raw = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`config is not valid JSON: ${file}`);
  }
  return parseConfig(parsed);
}

export function parseConfig(value: unknown): AppConfig {
  const root = record(value, "config");
  unknownKeys(root, TOP_KEYS, "config");
  const feishu = record(root.feishu, "feishu");
  unknownKeys(feishu, new Set(["appIdEnv", "appSecretEnv", "domain", "botOpenId"]), "feishu");
  const appId = envString(requiredString(feishu.appIdEnv, "feishu.appIdEnv"), "feishu.appIdEnv");
  const appSecret = envString(
    requiredString(feishu.appSecretEnv, "feishu.appSecretEnv"),
    "feishu.appSecretEnv",
  );
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
    throw new Error("feishu app id must look like cli_ plus 16 hex characters");
  }
  const domain = feishu.domain === undefined ? "feishu" : feishu.domain;
  if (domain !== "feishu" && domain !== "lark") {
    throw new Error('feishu.domain must be "feishu" or "lark"');
  }
  const botOpenId = optionalString(feishu.botOpenId, "feishu.botOpenId");
  if (botOpenId && !botOpenId.startsWith("ou_")) {
    throw new Error("feishu.botOpenId must be an open_id (ou_)");
  }

  const ownerOpenId = requiredString(root.ownerOpenId, "ownerOpenId");
  if (!ownerOpenId.startsWith("ou_")) throw new Error("ownerOpenId must be an open_id (ou_)");

  const wechat = root.wechat === undefined ? undefined : parseWechat(root.wechat);

  const allowRaw = root.allow === undefined ? {} : record(root.allow, "allow");
  unknownKeys(allowRaw, new Set(["users", "trustedUsers", "chats", "trustedBots"]), "allow");
  const users = idList(allowRaw.users, "allow.users", "ou_");
  const trustedUsers = idList(allowRaw.trustedUsers, "allow.trustedUsers", "ou_");
  const chats = idList(allowRaw.chats, "allow.chats", "oc_");
  const trustedBots = idList(allowRaw.trustedBots, "allow.trustedBots", "ou_");

  const routes = stringMap(root.routes === undefined ? {} : root.routes, "routes");
  const defaultBot = requiredString(root.defaultBot, "defaultBot");
  const botsRaw = record(root.bots, "bots");
  const bots: AppConfig["bots"] = {};
  for (const [name, entry] of Object.entries(botsRaw)) {
    const bot = record(entry, `bots.${name}`);
    unknownKeys(bot, new Set(["webhookUrl", "webhookKeyEnv"]), `bots.${name}`);
    const webhookUrl = requiredString(bot.webhookUrl, `bots.${name}.webhookUrl`);
    if (!/^https:\/\//.test(webhookUrl)) {
      throw new Error(`bots.${name}.webhookUrl must be https`);
    }
    const webhookKey = envString(
      requiredString(bot.webhookKeyEnv, `bots.${name}.webhookKeyEnv`),
      `bots.${name}.webhookKeyEnv`,
    );
    bots[name] = { webhookUrl, webhookKey };
  }
  if (!bots[defaultBot]) throw new Error(`defaultBot "${defaultBot}" is not in bots`);
  for (const [scope, botName] of Object.entries(routes)) {
    if (!bots[botName]) throw new Error(`route ${scope} points at unknown bot "${botName}"`);
  }

  const httpRaw = root.http === undefined ? {} : record(root.http, "http");
  unknownKeys(httpRaw, new Set(["host", "port", "tokenEnv"]), "http");
  const host = httpRaw.host === undefined ? "127.0.0.1" : requiredString(httpRaw.host, "http.host");
  const port = httpRaw.port === undefined ? 8787 : requiredNumber(httpRaw.port, "http.port");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("http.port must be an integer from 1 to 65535");
  }
  const tokenEnv = optionalString(httpRaw.tokenEnv, "http.tokenEnv");
  const token = tokenEnv ? envString(tokenEnv, "http.tokenEnv") : undefined;
  if (!isLoopback(host) && !token) {
    throw new Error("http.host is not loopback; set http.tokenEnv");
  }

  const dataDir = root.dataDir === undefined ? "data" : requiredString(root.dataDir, "dataDir");
  const deliveryTimeoutMs =
    root.deliveryTimeoutMs === undefined
      ? 15 * 60 * 1000
      : requiredNumber(root.deliveryTimeoutMs, "deliveryTimeoutMs");
  if (deliveryTimeoutMs < 1000) throw new Error("deliveryTimeoutMs must be at least 1000");
  const maxBotExchanges =
    root.maxBotExchanges === undefined
      ? 5
      : requiredNumber(root.maxBotExchanges, "maxBotExchanges");
  if (!Number.isInteger(maxBotExchanges) || maxBotExchanges < 1) {
    throw new Error("maxBotExchanges must be an integer >= 1");
  }
  const contextMessages =
    root.contextMessages === undefined
      ? 8
      : requiredNumber(root.contextMessages, "contextMessages");
  if (!Number.isInteger(contextMessages) || contextMessages < 0) {
    throw new Error("contextMessages must be an integer >= 0");
  }

  return {
    feishu: {
      appId,
      appSecret,
      domain,
      ...(botOpenId ? { botOpenId } : {}),
    },
    ...(wechat ? { wechat } : {}),
    ownerOpenId,
    allow: { users, trustedUsers, chats, trustedBots },
    routes,
    defaultBot,
    bots,
    http: { host, port, ...(token ? { token } : {}) },
    dataDir,
    deliveryTimeoutMs,
    maxBotExchanges,
    contextMessages,
    identity: {
      appId,
      appSecret,
      domain,
      botOpenId: botOpenId ?? "",
      host,
      port,
      token: token ?? "",
      dataDir,
      wechatCredentials: wechat?.credentialsFile ?? "",
    },
  };
}

function parseWechat(value: unknown): WechatConfig {
  const wechat = record(value, "wechat");
  unknownKeys(wechat, new Set(["credentialsFile", "ownerUserId", "allow"]), "wechat");
  const credentialsFile = expandHome(
    wechat.credentialsFile === undefined
      ? defaultCredentialsFile()
      : requiredString(wechat.credentialsFile, "wechat.credentialsFile"),
  );
  const ownerUserId = optionalString(wechat.ownerUserId, "wechat.ownerUserId");
  if (ownerUserId && !/^[A-Za-z0-9._-]+@im\.wechat$/.test(ownerUserId)) {
    throw new Error("wechat.ownerUserId must be an iLink user id (...@im.wechat)");
  }
  const allowRaw = wechat.allow === undefined ? {} : record(wechat.allow, "wechat.allow");
  unknownKeys(allowRaw, new Set(["users", "trustedUsers", "trustedBots"]), "wechat.allow");
  return {
    credentialsFile,
    ...(ownerUserId ? { ownerUserId } : {}),
    allow: {
      users: ilinkList(allowRaw.users, "wechat.allow.users"),
      trustedUsers: ilinkList(allowRaw.trustedUsers, "wechat.allow.trustedUsers"),
      trustedBots: ilinkList(allowRaw.trustedBots, "wechat.allow.trustedBots"),
    },
  };
}

function defaultCredentialsFile(): string {
  const dir = process.env.WEIXIN_CLI_CONFIG_DIR || path.join(os.homedir(), ".config", "weixin-cli");
  return path.join(dir, "credentials.json");
}

function expandHome(file: string): string {
  if (file === "~") return os.homedir();
  if (file.startsWith("~/")) return path.join(os.homedir(), file.slice(2));
  return file;
}

function ilinkList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    const id = requiredString(item, `${label}[${index}]`);
    if (!isIlinkId(id)) {
      throw new Error(`${label}[${index}] must be an iLink id (...@im.wechat or ...@im.bot)`);
    }
    return id;
  });
}

export function sameIdentity(a: AppConfig["identity"], b: AppConfig["identity"]): boolean {
  return (
    a.appId === b.appId &&
    a.appSecret === b.appSecret &&
    a.domain === b.domain &&
    a.botOpenId === b.botOpenId &&
    a.host === b.host &&
    a.port === b.port &&
    a.token === b.token &&
    a.dataDir === b.dataDir &&
    a.wechatCredentials === b.wechatCredentials
  );
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function envString(name: string, label: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${label} refers to ${name}, which is empty or unset`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unknown key "${key}"`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must be a string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  return requiredString(value, label);
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label} must be a number`);
  return value;
}

function idList(value: unknown, label: string, prefix: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    const id = requiredString(item, `${label}[${index}]`);
    if (!id.startsWith(prefix)) throw new Error(`${label}[${index}] must start with ${prefix}`);
    return id;
  });
}

function stringMap(value: unknown, label: string): Record<string, string> {
  const source = record(value, label);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    out[key] = requiredString(item, `${label}.${key}`);
  }
  return out;
}
