export interface LoopDecision {
  forward: boolean;
  notifyOwner: boolean;
  count: number;
}

/**
 * Counts consecutive inbound bot messages in a scope.
 * A user message resets the count. The max-th bot message is still
 * forwarded; the next one is dropped, and the owner is notified once.
 */
export function nextLoop(count: number, senderType: "user" | "bot", max: number): LoopDecision {
  if (senderType === "user") {
    return { forward: true, notifyOwner: false, count: 0 };
  }
  if (count >= max) {
    const notifyOwner = count === max;
    return { forward: false, notifyOwner, count: notifyOwner ? count + 1 : count };
  }
  return { forward: true, notifyOwner: false, count: count + 1 };
}
