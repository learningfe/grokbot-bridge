import assert from "node:assert/strict";
import test from "node:test";
import { checkSendTarget, type SendPolicy } from "../src/send-guard.js";

const policy: SendPolicy = {
  ownerId: "ou_owner",
  users: new Set(["ou_allowed"]),
  trustedUsers: new Set(["ou_trusted"]),
  trustedBots: new Set(["ou_bot_friend"]),
  chats: new Set(["oc_room"]),
};

test("proactive send accepts only allowlisted open ids and chat ids", () => {
  assert.equal(checkSendTarget("ou_owner", policy).ok, true);
  assert.equal(checkSendTarget("ou_allowed", policy).ok, true);
  assert.equal(checkSendTarget("ou_trusted", policy).ok, true);
  assert.equal(checkSendTarget("ou_bot_friend", policy).ok, true);
  assert.deepEqual(checkSendTarget("oc_room", policy), { ok: true, receiveIdType: "chat_id" });

  for (const target of ["ou_stranger", "oc_other", "Owner", "cli_app", "ou_owner ", ""]) {
    const result = checkSendTarget(target, policy);
    assert.equal(result.ok, false, target);
    if (!result.ok) assert.match(result.message, /allowlist/);
  }
});
