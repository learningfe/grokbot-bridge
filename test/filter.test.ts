import assert from "node:assert/strict";
import test from "node:test";
import { acceptInbound, inConversation, type FilterInput } from "../src/filter.js";

function input(overrides: Partial<FilterInput> = {}): FilterInput {
  return {
    chatType: "group",
    chatId: "oc_room",
    senderId: "ou_stranger",
    selfBotId: "ou_self",
    trust: "unknown",
    mentionedBot: false,
    repliesToBot: false,
    allowedChats: new Set(["oc_room"]),
    ...overrides,
  };
}

test("direct messages allow owner, trusted users, allowed users, and trusted bots", () => {
  for (const trust of ["owner", "trusted_user", "allowed_user", "trusted_bot"] as const) {
    assert.equal(acceptInbound(input({ chatType: "p2p", trust })), true, trust);
  }
  assert.equal(acceptInbound(input({ chatType: "p2p", trust: "unknown" })), false);
});

test("group messages need an allowlisted chat and a mention, a reply to us, or a trusted bot", () => {
  assert.equal(acceptInbound(input({ mentionedBot: true })), true);
  assert.equal(acceptInbound(input({ repliesToBot: true })), true);
  assert.equal(acceptInbound(input({ trust: "trusted_bot" })), true);
  assert.equal(acceptInbound(input({ trust: "owner" })), false);
  assert.equal(inConversation(input({ trust: "owner" })), true);
  assert.equal(acceptInbound(input({ trust: "trusted_user" })), false);
  assert.equal(acceptInbound(input({ mentionedBot: true, allowedChats: new Set() })), false);
  assert.equal(acceptInbound(input({ trust: "unknown", mentionedBot: false })), false);
  assert.equal(
    acceptInbound(input({ senderId: "ou_other_bot", trust: "unknown", mentionedBot: true })),
    true,
  );
});

test("the bridge bot's own messages are dropped", () => {
  assert.equal(
    acceptInbound(input({ senderId: "ou_self", trust: "trusted_bot", mentionedBot: true })),
    false,
  );
});
