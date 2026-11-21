import type { QueuedEvent } from "./types";

export interface EventStorage {
  get(): QueuedEvent[];
  set(events: QueuedEvent[]): void;
}

export function createStorage(persist: boolean): EventStorage {
  if (persist && typeof localStorage !== "undefined") {
    const key = "markova:queue";
    return {
      get(): QueuedEvent[] {
        try {
          const raw = localStorage.getItem(key);
          return raw ? (JSON.parse(raw) as QueuedEvent[]) : [];
        } catch {
          return [];
        }
      },
      set(events: QueuedEvent[]): void {
        try {
          localStorage.setItem(key, JSON.stringify(events));
        } catch {
          // Storage full or unavailable - the in-memory queue keeps working.
        }
      },
    };
  }
  let memory: QueuedEvent[] = [];
  return {
    get: () => memory,
    set: (events: QueuedEvent[]) => {
      memory = events;
    },
  };
}

export class EventQueue {
  private events: QueuedEvent[] = [];
  private inFlight = false;

  constructor(
    private readonly storage: EventStorage,
    private readonly maxQueueSize: number,
  ) {
    this.events = storage.get();
  }

  enqueue(event: QueuedEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxQueueSize) {
      this.events = this.events.slice(-this.maxQueueSize);
    }
    this.persist();
  }

  size(): number {
    return this.events.length;
  }

  takeBatch(maxSize: number): QueuedEvent[] {
    const batch = this.events.slice(0, maxSize);
    return batch;
  }

  removeBatch(batch: QueuedEvent[]): void {
    const ids = new Set(batch.map((event) => event.eventId));
    this.events = this.events.filter((event) => !ids.has(event.eventId));
    this.persist();
  }

  requeue(batch: QueuedEvent[]): void {
    // Keep the batch but put it back at the front to preserve ordering.
    const ids = new Set(batch.map((event) => event.eventId));
    const rest = this.events.filter((event) => !ids.has(event.eventId));
    this.events = [...batch, ...rest].slice(-this.maxQueueSize);
    this.persist();
  }

  private persist(): void {
    this.storage.set(this.events);
  }
}
