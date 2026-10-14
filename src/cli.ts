#!/usr/bin/env node
import { feishuUuid, isFeishuUuid } from "./uuid.js";

const HELP = `grokbot-bridge serve --config <file>
grokbot-bridge reply <event_id> --text <text> [--uuid <id>]
grokbot-bridge noreply <event_id>
grokbot-bridge send --to <open_id|chat_id> --text <text> [--uuid <id>]
grokbot-bridge react <message_id> <emoji>

The CLI talks to the bridge HTTP API on GROKBOT_BRIDGE_URL (default http://127.0.0.1:8787).
Set GROKBOT_BRIDGE_TOKEN when the bridge requires a token.
Pass --text - to read the message from stdin.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positionals[0];
  if (!command || command === "help" || args.options.help === true) {
    console.log(HELP);
    return;
  }
  if (command === "serve") {
    const configPath =
      stringOption(args.options.config) ?? process.env.GROKBOT_BRIDGE_CONFIG ?? "config.json";
    const { serve } = await import("./serve.js");
    await serve(configPath);
    return;
  }
  const base = (process.env.GROKBOT_BRIDGE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const token = process.env.GROKBOT_BRIDGE_TOKEN;
  if (command === "reply") {
    const eventId = args.positionals[1];
    if (!eventId) fail("reply needs an event id");
    await call(base, token, "/v1/reply", {
      eventId,
      text: await readText(stringOption(args.options.text)),
      uuid: readUuid(args.options.uuid),
    });
    return;
  }
  if (command === "noreply") {
    const eventId = args.positionals[1];
    if (!eventId) fail("noreply needs an event id");
    await call(base, token, "/v1/noreply", { eventId });
    return;
  }
  if (command === "send") {
    const to = stringOption(args.options.to);
    if (!to) fail("send needs --to");
    await call(base, token, "/v1/send", {
      to,
      text: await readText(stringOption(args.options.text)),
      uuid: readUuid(args.options.uuid),
    });
    return;
  }
  if (command === "react") {
    const messageId = args.positionals[1];
    const emoji = args.positionals[2] ?? stringOption(args.options.emoji);
    if (!messageId || !emoji) fail("react needs a message id and an emoji type");
    await call(base, token, "/v1/react", { messageId, emoji });
    return;
  }
  fail(`unknown command ${command}`);
}

async function call(
  base: string,
  token: string | undefined,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  let last = "bridge_unreachable";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const payload = (await response.json()) as unknown;
      console.log(JSON.stringify(payload));
      process.exitCode = response.ok ? 0 : 1;
      return;
    } catch {
      last = "bridge_unreachable";
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  console.log(JSON.stringify({ ok: false, error: last }));
  process.exitCode = 1;
}

function readUuid(value: string | boolean | undefined): string {
  if (typeof value !== "string") return feishuUuid();
  if (!isFeishuUuid(value)) fail("uuid must be 1-50 letters, digits, or hyphens");
  return value;
}

async function readText(value: string | undefined): Promise<string> {
  if (value === undefined) fail("missing --text");
  if (value !== "-") return value;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function stringOption(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

interface Parsed {
  positionals: string[];
  options: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) options[name] = true;
    else {
      options[name] = next;
      i += 1;
    }
  }
  return { positionals, options };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "failed");
  process.exit(1);
});
