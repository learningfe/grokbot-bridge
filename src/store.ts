import fs from "node:fs";
import path from "node:path";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface TrackedEvent {
  messageId: string;
  inThread: boolean;
  at: number;
}

export interface QueueSnapshotScope {
  inflight: unknown[] | null;
  awaiting: boolean;
  startedAt: number;
  pending: unknown[];
}

export interface QueueSnapshot {
  [scope: string]: QueueSnapshotScope;
}

interface DiskState {
  seen: Record<string, number>;
  sent: Record<string, number>;
  recalled: Record<string, number>;
  loops: Record<string, number>;
  tracked: Record<string, TrackedEvent>;
  queues: QueueSnapshot;
}

function emptyState(): DiskState {
  return { seen: {}, sent: {}, recalled: {}, loops: {}, tracked: {}, queues: {} };
}

export class Store {
  private state: DiskState;

  private constructor(
    private readonly file: string,
    state: DiskState,
  ) {
    this.state = state;
  }

  static open(dataDir: string, now = Date.now()): Store {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "state.json");
    let state = emptyState();
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new Error(`state file is not valid JSON: ${file}`);
      }
      state = normalizeState(parsed);
    }
    const store = new Store(file, state);
    if (store.prune(now)) store.persist();
    return store;
  }

  hasSeen(id: string): boolean {
    return this.state.seen[id] !== undefined;
  }

  /**
   * Remember ids in memory. Returns false, and writes nothing, when any id
   * is already known — the caller must flush to make a successful claim durable.
   */
  stageSeen(ids: string[], now = Date.now()): boolean {
    if (ids.length === 0) return false;
    for (const id of ids) {
      if (this.state.seen[id] !== undefined) return false;
    }
    for (const id of ids) this.state.seen[id] = now;
    return true;
  }

  /** True when every id is new. A duplicate adds nothing. */
  claimSeen(ids: string[], now = Date.now()): boolean {
    if (!this.stageSeen(ids, now)) return false;
    this.flush();
    return true;
  }

  stageTrack(eventId: string, messageId: string, inThread: boolean, now = Date.now()): void {
    this.state.tracked[eventId] = { messageId, inThread, at: now };
  }

  stageLoop(scope: string, count: number): void {
    if (count === 0) delete this.state.loops[scope];
    else this.state.loops[scope] = count;
  }

  flush(): void {
    this.persist();
  }

  wasSent(messageId: string): boolean {
    return this.state.sent[messageId] !== undefined;
  }

  markSent(messageId: string, now = Date.now()): void {
    this.state.sent[messageId] = now;
    this.persist();
  }

  wasRecalled(messageId: string): boolean {
    return this.state.recalled[messageId] !== undefined;
  }

  markRecalled(messageId: string, now = Date.now()): void {
    this.state.recalled[messageId] = now;
    this.persist();
  }

  loopCount(scope: string): number {
    return this.state.loops[scope] ?? 0;
  }

  tracked(eventId: string): TrackedEvent | undefined {
    return this.state.tracked[eventId];
  }

  queues(): QueueSnapshot {
    return this.state.queues;
  }

  saveQueues(queues: QueueSnapshot): void {
    this.state.queues = queues;
    this.persist();
  }

  private prune(now: number): boolean {
    const cutoff = now - RETENTION_MS;
    let changed = false;
    for (const bag of [this.state.seen, this.state.sent, this.state.recalled]) {
      for (const [id, at] of Object.entries(bag)) {
        if (at < cutoff) {
          delete bag[id];
          changed = true;
        }
      }
    }
    for (const [id, event] of Object.entries(this.state.tracked)) {
      if (event.at < cutoff) {
        delete this.state.tracked[id];
        changed = true;
      }
    }
    return changed;
  }

  private persist(): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }
}

function normalizeState(value: unknown): DiskState {
  if (typeof value !== "object" || value === null) return emptyState();
  const raw = value as Partial<DiskState>;
  return {
    seen: numberMap(raw.seen),
    sent: numberMap(raw.sent),
    recalled: numberMap(raw.recalled),
    loops: numberMap(raw.loops),
    tracked: trackedMap(raw.tracked),
    queues: raw.queues && typeof raw.queues === "object" ? raw.queues : {},
  };
}

function numberMap(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number") out[key] = item;
  }
  return out;
}

function trackedMap(value: unknown): Record<string, TrackedEvent> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, TrackedEvent> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Partial<TrackedEvent>;
    if (typeof row.messageId !== "string" || typeof row.at !== "number") continue;
    out[key] = { messageId: row.messageId, inThread: row.inThread === true, at: row.at };
  }
  return out;
}
