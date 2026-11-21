import { validate, identifyInputSchema, pushTokenSchema, trackInputSchema } from "./schemas";
import { createStorage, EventQueue } from "./queue";
import { backoffDelay, classifyHttpError, isRetryable, sleep } from "./retry";
import { detectContext, platformFromString, randomId, SessionTracker } from "./session";
import {
  FlushResult,
  MarkovaError,
  MarkovaOptions,
  NotificationPreference,
  PushTokenRegistration,
  QueuedEvent,
  UserTraits,
} from "./types";

/**
 * MARKOVA tracking client for web and Node.js.
 *
 * ```ts
 * const markova = new Markova({ apiKey: "mk_live_...", endpoint: "https://api.example.com" });
 * await markova.identify("user_123", { name: "John", email: "john@example.com" });
 * markova.track("Product Purchased", { productId: "product_1", price: 99 });
 * await markova.flush();
 * ```
 */
export class Markova {
  private readonly options: Required<
    Pick<
      MarkovaOptions,
      "flushInterval" | "batchSize" | "maxQueueSize" | "maxRetries" | "persistQueue" | "debug"
    >
  >;
  private readonly queue: EventQueue;
  private readonly session: SessionTracker;
  private userId: string | undefined;
  private anonymousId: string;
  private flushTimer?: ReturnType<typeof setInterval>;
  private flushing: Promise<FlushResult> | null = null;

  constructor(private readonly config: MarkovaOptions) {
    if (!config.apiKey) throw new MarkovaError("VALIDATION_ERROR", "apiKey is required");
    if (!config.endpoint) throw new MarkovaError("VALIDATION_ERROR", "endpoint is required");
    this.options = {
      flushInterval: config.flushInterval ?? 5000,
      batchSize: config.batchSize ?? 20,
      maxQueueSize: config.maxQueueSize ?? 1000,
      maxRetries: config.maxRetries ?? 3,
      persistQueue: config.persistQueue ?? true,
      debug: config.debug ?? false,
    };
    this.session = new SessionTracker();
    this.anonymousId = this.session.getAnonymousId();
    this.queue = new EventQueue(createStorage(this.options.persistQueue), this.options.maxQueueSize);
    if (this.options.flushInterval > 0) {
      this.flushTimer = setInterval(() => void this.flush().catch(() => undefined), this.options.flushInterval);
      if (typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
        (this.flushTimer as { unref: () => void }).unref();
      }
    }
  }

  // ---- Identity ----

  /** Identify a user; links the anonymous identity server-side and locally. */
  async identify(userId: string, traits: UserTraits = {}): Promise<{ profileId?: string }> {
    const input = validate(identifyInputSchema, { userId, traits });
    this.userId = input.userId;
    this.session.touch();

    const response = await this.request<{ profileId: string }>("/api/v1/identify", {
      userId: input.userId,
      anonymousId: this.anonymousId,
      traits: input.traits,
    });
    return { profileId: response?.profileId };
  }

  resetIdentity(): void {
    this.userId = undefined;
    this.session.reset();
    this.anonymousId = this.session.getAnonymousId();
  }

  // ---- Tracking ----

  track(eventName: string, properties: Record<string, unknown> = {}): void {
    const input = validate(trackInputSchema, { eventName, properties });
    this.session.touch();
    this.enqueue(input.eventName, input.properties);
    if (this.queue.size() >= this.options.batchSize) {
      void this.flush().catch(() => undefined);
    }
  }

  pageViewed(properties: Record<string, unknown> = {}): void {
    this.track("Page Viewed", {
      page: typeof location !== "undefined" ? location.pathname : undefined,
      ...properties,
    });
  }

  async registerPushToken(registration: PushTokenRegistration): Promise<{ profileId?: string }> {
    const input = validate(pushTokenSchema, registration);
    const response = await this.request<{ profileId: string }>("/api/v1/devices", {
      userId: this.userId,
      anonymousId: this.anonymousId,
      platform: input.platform,
      pushToken: input.pushToken,
      deviceInfo: input.deviceInfo,
    });
    return { profileId: response?.profileId };
  }

  async updateNotificationPreferences(preferences: NotificationPreference[]): Promise<void> {
    if (!this.userId) {
      throw new MarkovaError("VALIDATION_ERROR", "Call identify() before updating notification preferences");
    }
    await this.request("/api/v1/notifications/preferences", {
      userId: this.userId,
      channels: preferences,
    });
  }

  async unsubscribe(channel: NotificationPreference["channel"]): Promise<void> {
    if (!this.userId) {
      throw new MarkovaError("VALIDATION_ERROR", "Call identify() before unsubscribing");
    }
    await this.request("/api/v1/notifications/unsubscribe", { userId: this.userId, channel });
  }

  async assignExperiment(experimentKey: string): Promise<{ variantKey: string | null; enrolled: boolean }> {
    const result = await this.request<{ variantKey: string | null; enrolled: boolean }>(
      "/api/v1/experiments/assign",
      { experimentKey, userId: this.userId ?? this.anonymousId },
    );
    return result ?? { variantKey: null, enrolled: false };
  }

  // ---- Queue + flush ----

  private enqueue(eventName: string, properties: Record<string, unknown>): void {
    const event: QueuedEvent = {
      eventId: randomId(),
      eventName,
      anonymousId: this.anonymousId,
      userId: this.userId,
      properties,
      timestamp: new Date().toISOString(),
      context: detectContext(this.session.getSessionId()),
    };
    this.queue.enqueue(event);
  }

  /** Sends all queued events; resolves with delivery counts. */
  async flush(): Promise<FlushResult> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushInternal().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushInternal(): Promise<FlushResult> {
    const result: FlushResult = { delivered: 0, failed: 0, queued: this.queue.size() };

    while (this.queue.size() > 0) {
      const batch = this.queue.takeBatch(Math.max(1, this.options.batchSize));
      if (batch.length === 0) break;

      try {
        await this.sendBatch(batch);
        this.queue.removeBatch(batch);
        result.delivered += batch.length;
      } catch (error) {
        if (!isRetryable(error)) {
          // Permanent rejection (e.g. invalid schema): drop and report.
          this.queue.removeBatch(batch);
          result.failed += batch.length;
          this.config.onError?.(error as MarkovaError);
          continue;
        }
        this.queue.requeue(batch);
        result.queued = this.queue.size();
        this.config.onError?.(error as MarkovaError);
        break;
      }
    }
    return result;
  }

  private async sendBatch(batch: QueuedEvent[]): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.options.maxRetries; attempt += 1) {
      try {
        await this.request("/api/v1/events/batch", { events: batch });
        return;
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) throw error;
        if (attempt < this.options.maxRetries - 1) {
          await sleep(backoffDelay(attempt));
        }
      }
    }
    throw lastError;
  }

  private async request<T = unknown>(path: string, body: unknown): Promise<T | undefined> {
    let response: Response;
    try {
      response = await fetch(`${this.config.endpoint.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Markova-Key": this.config.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new MarkovaError("NETWORK_ERROR", `Network request failed: ${(error as Error).message}`);
    }

    if (!response.ok) {
      throw classifyHttpError(response.status);
    }
    if (response.status === 204) return undefined;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await response.json()) as T;
    }
    return undefined;
  }

  // ---- Lifecycle ----

  startAutoFlush(intervalMs?: number): void {
    this.stopAutoFlush();
    const interval = intervalMs ?? this.options.flushInterval;
    if (interval > 0) {
      this.flushTimer = setInterval(() => void this.flush().catch(() => undefined), interval);
      if (typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
        (this.flushTimer as { unref: () => void }).unref();
      }
    }
  }

  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  pendingEvents(): number {
    return this.queue.size();
  }

  getSessionId(): string {
    return this.session.getSessionId();
  }

  getAnonymousId(): string {
    return this.anonymousId;
  }

  currentPlatform() {
    return platformFromString(detectContext(this.session.getSessionId()).platform);
  }
}
