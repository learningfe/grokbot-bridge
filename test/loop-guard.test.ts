import assert from "node:assert/strict";
import test from "node:test";
import { nextLoop } from "../src/loop-guard.js";

test("bot exchanges stop after the limit and a person resets the scope", () => {
  let count = 0;
  const first = nextLoop(count, "bot", 2);
  assert.deepEqual(first, { forward: true, notifyOwner: false, count: 1 });
  count = first.count;
  const second = nextLoop(count, "bot", 2);
  assert.deepEqual(second, { forward: true, notifyOwner: false, count: 2 });
  count = second.count;
  const third = nextLoop(count, "bot", 2);
  assert.deepEqual(third, { forward: false, notifyOwner: true, count: 3 });
  count = third.count;
  const fourth = nextLoop(count, "bot", 2);
  assert.deepEqual(fourth, { forward: false, notifyOwner: false, count: 3 });
  const human = nextLoop(fourth.count, "user", 2);
  assert.deepEqual(human, { forward: true, notifyOwner: false, count: 0 });
  assert.equal(nextLoop(human.count, "bot", 2).forward, true);
});
