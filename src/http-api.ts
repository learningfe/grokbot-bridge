import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { feishuUuid, isFeishuUuid } from "./uuid.js";

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

export interface OutboundApi {
  reply(eventId: string, text: string, uuid: string): Promise<ApiResult>;
  noreply(eventId: string): Promise<ApiResult>;
  send(to: string, text: string, uuid: string): Promise<ApiResult>;
  react(messageId: string, emoji: string): Promise<ApiResult>;
}

const BODY_LIMIT = 1_000_000;

export function startHttp(options: {
  host: string;
  port: number;
  token?: string;
  api: OutboundApi;
}): Promise<{ close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handle(req, res, options).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "bad request";
      writeJson(res, 400, { ok: false, error: "bad_request", message });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      resolve({
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: { token?: string; api: OutboundApi },
): Promise<void> {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (req.method === "GET" && path === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== "POST") {
    writeJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  if (options.token && !authorized(req.headers.authorization, options.token)) {
    writeJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  const body = await readJson(req);
  const record = asRecord(body);
  if (!record) {
    writeJson(res, 400, { ok: false, error: "bad_request", message: "JSON object required" });
    return;
  }
  const result = await dispatch(path, record, options.api);
  writeJson(res, result.status, result.body);
}

async function dispatch(
  path: string,
  body: Record<string, unknown>,
  api: OutboundApi,
): Promise<ApiResult> {
  if (path === "/v1/reply") {
    const eventId = requiredString(body.eventId, "eventId");
    const text = requiredText(body.text);
    const uuid = optionalUuid(body.uuid);
    return api.reply(eventId, text, uuid);
  }
  if (path === "/v1/noreply") {
    return api.noreply(requiredString(body.eventId, "eventId"));
  }
  if (path === "/v1/send") {
    const to = requiredString(body.to, "to");
    const text = requiredText(body.text);
    const uuid = optionalUuid(body.uuid);
    return api.send(to, text, uuid);
  }
  if (path === "/v1/react") {
    const messageId = requiredString(body.messageId, "messageId");
    const emoji = requiredString(body.emoji, "emoji");
    if (!/^[A-Z0-9_]{1,64}$/.test(emoji)) {
      return {
        status: 400,
        body: {
          ok: false,
          error: "bad_request",
          message: "emoji must be a Feishu emoji type such as THUMBSUP",
        },
      };
    }
    return api.react(messageId, emoji);
  }
  return { status: 404, body: { ok: false, error: "not_found" } };
}

function optionalUuid(value: unknown): string {
  if (value === undefined) return feishuUuid();
  if (typeof value !== "string" || !isFeishuUuid(value)) {
    throw new Error("uuid must be 1-50 characters of letters, digits, or hyphen");
  }
  return value;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("text is required");
  if (value.length > 100_000) throw new Error("text is too long");
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function authorized(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const left = Buffer.from(presented);
  const right = Buffer.from(token);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error("body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function writeJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
