export interface ScopeBatch<T> {
  scope: string;
  events: T[];
}

export interface QueueSnapshotT<T> {
  [scope: string]: {
    inflight: T[] | null;
    awaiting: boolean;
    startedAt: number;
    pending: T[];
  };
}

interface Slot<T extends { id: string }> {
  inflight: { events: T[]; phase: "delivering" | "awaiting"; startedAt: number } | null;
  pending: T[];
  generation: number;
  timer: { cancel(): void } | null;
  wait: { resolve: () => void } | null;
  running: boolean;
}

export class ScopeQueue<T extends { id: string }> {
  private readonly slots = new Map<string, Slot<T>>();
  private deliveryCount = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly opts: {
      deliver: (batch: ScopeBatch<T>) => Promise<void>;
      timeoutMs: () => number;
      onTimeout: (scope: string, eventIds: string[]) => void;
      onDeliveryError: (scope: string, eventIds: string[], error: unknown) => void;
      onChange?: () => void;
      schedule: (fn: () => void, ms: number) => { cancel(): void };
      now?: () => number;
    },
  ) {}

  enqueue(scope: string, event: T): void {
    const slot = this.slot(scope);
    slot.pending.push(event);
    this.changed();
    this.ensure(scope);
  }

  /**
   * Release the in-flight batch that contains this event.
   * Returns false when the id is not the batch currently waiting on the bot.
   */
  complete(eventId: string): boolean {
    for (const slot of this.slots.values()) {
      if (!slot.inflight || slot.inflight.phase !== "awaiting") continue;
      if (!slot.inflight.events.some((event) => event.id === eventId)) continue;
      this.release(slot);
      return true;
    }
    return false;
  }

  snapshot(): QueueSnapshotT<T> {
    const out: QueueSnapshotT<T> = {};
    for (const [scope, slot] of this.slots) {
      if (!slot.inflight && slot.pending.length === 0) continue;
      out[scope] = {
        inflight: slot.inflight?.events ?? null,
        awaiting: slot.inflight?.phase === "awaiting",
        startedAt: slot.inflight?.startedAt ?? 0,
        pending: slot.pending.slice(),
      };
    }
    return out;
  }

  restore(saved: QueueSnapshotT<T>): void {
    for (const [scope, row] of Object.entries(saved)) {
      const slot = this.slot(scope);
      slot.pending = row.pending.slice();
      if (row.inflight && row.inflight.length > 0 && row.awaiting) {
        slot.inflight = {
          events: row.inflight.slice(),
          phase: "awaiting",
          startedAt: row.startedAt,
        };
      } else if (row.inflight && row.inflight.length > 0) {
        slot.pending = [...row.inflight, ...slot.pending];
      }
      this.ensure(scope);
    }
  }

  waitForDeliveries(count: number): Promise<void> {
    if (this.deliveryCount >= count && this.isQuiet()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.deliveryCount >= count && this.isQuiet()) {
          this.listeners.delete(check);
          resolve();
        }
      };
      this.listeners.add(check);
    });
  }

  private ensure(scope: string): void {
    const slot = this.slot(scope);
    if (slot.running) return;
    slot.running = true;
    void this.pump(scope).finally(() => {
      slot.running = false;
      if (!slot.inflight && slot.pending.length > 0) this.ensure(scope);
    });
  }

  private async pump(scope: string): Promise<void> {
    const slot = this.slot(scope);
    for (;;) {
      if (!slot.inflight) {
        if (slot.pending.length === 0) return;
        const events = slot.pending.splice(0);
        slot.inflight = { events, phase: "delivering", startedAt: this.now() };
        this.changed();
        try {
          await this.opts.deliver({ scope, events });
        } catch (error) {
          const ids = events.map((event) => event.id);
          slot.inflight = null;
          this.changed();
          this.opts.onDeliveryError(scope, ids, error);
          continue;
        }
        if (!slot.inflight) {
          this.touch();
          continue;
        }
        slot.inflight.phase = "awaiting";
        slot.inflight.startedAt = this.now();
        this.changed();
      }
      if (slot.inflight.phase !== "awaiting") return;
      const released = defer();
      slot.wait = released;
      const generation = ++slot.generation;
      const elapsed = this.now() - slot.inflight.startedAt;
      const remain = Math.max(0, this.opts.timeoutMs() - elapsed);
      slot.timer = this.opts.schedule(() => {
        if (slot.generation !== generation) return;
        this.fireTimeout(scope);
      }, remain);
      this.deliveryCount += 1;
      this.touch();
      await released.promise;
      slot.wait = null;
    }
  }

  private fireTimeout(scope: string): void {
    const slot = this.slot(scope);
    if (!slot.inflight || slot.inflight.phase !== "awaiting") return;
    const ids = slot.inflight.events.map((event) => event.id);
    this.release(slot);
    this.opts.onTimeout(scope, ids);
  }

  private release(slot: Slot<T>): void {
    slot.generation += 1;
    slot.timer?.cancel();
    slot.timer = null;
    slot.inflight = null;
    const wait = slot.wait;
    slot.wait = null;
    this.changed();
    wait?.resolve();
  }

  private isQuiet(): boolean {
    for (const slot of this.slots.values()) {
      if (slot.inflight?.phase === "delivering") return false;
    }
    return true;
  }

  private slot(scope: string): Slot<T> {
    let slot = this.slots.get(scope);
    if (!slot) {
      slot = {
        inflight: null,
        pending: [],
        generation: 0,
        timer: null,
        wait: null,
        running: false,
      };
      this.slots.set(scope, slot);
    }
    return slot;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private changed(): void {
    this.opts.onChange?.();
  }

  private touch(): void {
    for (const listener of this.listeners) listener();
  }
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
