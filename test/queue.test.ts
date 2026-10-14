import assert from "node:assert/strict";
import test from "node:test";
import { ScopeQueue } from "../src/scope-queue.js";

interface Item {
  id: string;
}

test("a busy scope holds later events and delivers them together", async () => {
  const batches: string[][] = [];
  const queue = new ScopeQueue<Item>({
    deliver: async (batch) => {
      batches.push(batch.events.map((event) => event.id));
    },
    timeoutMs: () => 60_000,
    onTimeout: () => {},
    onDeliveryError: () => {},
    schedule: () => ({ cancel() {} }),
  });

  queue.enqueue("group:oc_room", { id: "a" });
  await queue.waitForDeliveries(1);
  queue.enqueue("group:oc_room", { id: "b" });
  queue.enqueue("group:oc_room", { id: "c" });
  assert.deepEqual(batches, [["a"]]);
  assert.equal(queue.complete("nope"), false);
  assert.equal(queue.complete("a"), true);
  await queue.waitForDeliveries(2);
  assert.deepEqual(batches, [["a"], ["b", "c"]]);
  assert.equal(queue.complete("c"), true);
  assert.equal(queue.complete("b"), false);
});

test("different scopes are delivered without waiting for each other", async () => {
  const batches: string[][] = [];
  const queue = new ScopeQueue<Item>({
    deliver: async (batch) => {
      batches.push([batch.scope, ...batch.events.map((event) => event.id)]);
    },
    timeoutMs: () => 60_000,
    onTimeout: () => {},
    onDeliveryError: () => {},
    schedule: () => ({ cancel() {} }),
  });
  queue.enqueue("dm:ou_a", { id: "a" });
  queue.enqueue("group:oc_room", { id: "b" });
  await queue.waitForDeliveries(2);
  assert.deepEqual(batches, [
    ["dm:ou_a", "a"],
    ["group:oc_room", "b"],
  ]);
});

test("a timeout releases the scope and the queued events go out next", async () => {
  const batches: string[][] = [];
  const timeouts: string[][] = [];
  const timers: { fn: () => void; cancelled: boolean }[] = [];
  const queue = new ScopeQueue<Item>({
    deliver: async (batch) => {
      batches.push(batch.events.map((event) => event.id));
    },
    timeoutMs: () => 5_000,
    onTimeout: (scope, ids) => timeouts.push([scope, ...ids]),
    onDeliveryError: () => {},
    schedule: (fn) => {
      const timer = { fn, cancelled: false };
      timers.push(timer);
      return {
        cancel() {
          timer.cancelled = true;
        },
      };
    },
  });
  queue.enqueue("group:oc_room", { id: "a" });
  await queue.waitForDeliveries(1);
  queue.enqueue("group:oc_room", { id: "b" });
  const timer = timers[0];
  assert.ok(timer);
  assert.equal(timer.cancelled, false);
  timer.fn();
  await queue.waitForDeliveries(2);
  assert.deepEqual(timeouts, [["group:oc_room", "a"]]);
  assert.deepEqual(batches, [["a"], ["b"]]);
});
