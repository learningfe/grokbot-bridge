import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";

test("seen ids are durable and a partial duplicate claims nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grokbot-bridge-"));
  try {
    const first = Store.open(dir);
    assert.equal(first.claimSeen(["evt-1", "om-1"]), true);
    assert.equal(first.claimSeen(["evt-2", "om-1"]), false);
    assert.equal(first.hasSeen("evt-2"), false);
    assert.equal(first.hasSeen("evt-1"), true);

    const reopened = Store.open(dir);
    assert.equal(reopened.hasSeen("evt-1"), true);
    assert.equal(reopened.hasSeen("om-1"), true);
    assert.equal(reopened.claimSeen(["evt-1"]), false);
    assert.equal(reopened.claimSeen(["evt-3"]), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
