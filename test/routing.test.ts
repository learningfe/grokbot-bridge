import assert from "node:assert/strict";
import test from "node:test";
import { resolveBot, scopeKey } from "../src/routing.js";

test("scope keys distinguish direct messages, groups, and threads", () => {
  assert.equal(scopeKey({ chatType: "p2p", senderId: "ou_a", chatId: "oc_dm" }), "dm:ou_a");
  assert.equal(
    scopeKey({ chatType: "group", senderId: "ou_a", chatId: "oc_room" }),
    "group:oc_room",
  );
  assert.equal(
    scopeKey({ chatType: "group", senderId: "ou_a", chatId: "oc_room", threadId: "omt_1" }),
    "thread:omt_1",
  );
});

test("routing prefers the exact scope, then the parent group, then the default bot", () => {
  const routes = {
    "dm:ou_a": "alpha",
    "group:oc_room": "beta",
    "thread:omt_special": "gamma",
  };
  assert.equal(resolveBot("dm:ou_a", "oc_dm", routes, "default"), "alpha");
  assert.equal(resolveBot("dm:ou_other", "oc_dm", routes, "default"), "default");
  assert.equal(resolveBot("group:oc_room", "oc_room", routes, "default"), "beta");
  assert.equal(resolveBot("thread:omt_special", "oc_room", routes, "default"), "gamma");
  assert.equal(resolveBot("thread:omt_other", "oc_room", routes, "default"), "beta");
  assert.equal(resolveBot("thread:omt_other", "oc_unknown", routes, "default"), "default");
});
