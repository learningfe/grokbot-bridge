import { createHash, randomUUID } from "node:crypto";

const UUID_PATTERN = /^[A-Za-z0-9-]{1,50}$/;

export function feishuUuid(preferred?: string): string {
  if (preferred && UUID_PATTERN.test(preferred)) return preferred;
  return createHash("sha256").update(randomUUID()).digest("hex").slice(0, 32);
}

export function isFeishuUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
