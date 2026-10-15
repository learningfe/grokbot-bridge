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

  for (const target of [
    "ou_stranger",
    "oc_other",
    "Owner",
    "cli_app",
    "ou_owner ",
    "",
    "owner@im.wechat",
  ]) {
    const result = checkSendTarget(target, policy);
    assert.equal(result.ok, false, target);
    if (!result.ok) assert.match(result.message, /allowlist/);
  }
});

test("proactive send accepts allowlisted iLink user ids only when wechat policy is set", () => {
  const withWechat: SendPolicy = {
    ...policy,
    wechat: {
      ownerId: "owner_user@im.wechat",
      users: new Set(["pal_user@im.wechat"]),
      trustedUsers: new Set(["close_user@im.wechat"]),
      trustedBots: new Set(["friendbot@im.bot"]),
    },
  };
  assert.deepEqual(checkSendTarget("owner_user@im.wechat", withWechat), {
    ok: true,
    receiveIdType: "ilink_user",
  });
  assert.equal(checkSendTarget("pal_user@im.wechat", withWechat).ok, true);
  assert.equal(checkSendTarget("close_user@im.wechat", withWechat).ok, true);
  assert.equal(checkSendTarget("friendbot@im.bot", withWechat).ok, true);
  assert.equal(checkSendTarget("stranger@im.wechat", withWechat).ok, false);
  assert.equal(checkSendTarget("owner_user@im.wechat", policy).ok, false);
});
