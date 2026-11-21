export type Platform = "WEB" | "ANDROID" | "IOS" | "OTHER";

export interface MarkovaOptions {
  /** Project API key (mk_live_...) */
  apiKey: string;
  /** Backend base URL, e.g. https://api.markova.local */
  endpoint: string;
  /** Auto-flush interval in ms (default 5000). 0 disables auto-flush. */
  flushInterval?: number;
  /** Events buffered before an automatic flush (default 20). */
  batchSize?: number;
  /** Maximum events kept in the offline queue (default 1000). */
  maxQueueSize?: number;
  /** Retry attempts for failed batches (default 3). */
  maxRetries?: number;
  /** Persist the queue between page loads (browser only, default true). */
  persistQueue?: boolean;
  /** Attach captured errors to console (default false). */
  debug?: boolean;
  /** Called when an event fails validation or a batch exhausts retries. */
  onError?: (error: MarkovaError) => void;
}

export interface EventContext {
  sessionId?: string;
  platform?: Platform;
  os?: string;
  device?: string;
}

export type EventProperties = Record<string, unknown>;
export type UserTraits = Record<string, string | number | boolean | null>;

export interface QueuedEvent {
  eventId: string;
  eventName: string;
  anonymousId: string;
  userId?: string;
  properties: EventProperties;
  timestamp: string;
  context: EventContext;
}

export interface FlushResult {
  delivered: number;
  failed: number;
  queued: number;
}

export interface PushTokenRegistration {
  platform: Platform;
  pushToken: string;
  deviceInfo?: Record<string, unknown>;
}

export interface NotificationPreference {
  channel: "PUSH" | "EMAIL" | "IN_APP";
  enabled: boolean;
}

export type MarkovaErrorCode =
  | "VALIDATION_ERROR"
  | "NETWORK_ERROR"
  | "AUTH_ERROR"
  | "RATE_LIMITED"
  | "UNKNOWN_ERROR";

export class MarkovaError extends Error {
  readonly code: MarkovaErrorCode;
  readonly status?: number;
  readonly details?: unknown;

  constructor(code: MarkovaErrorCode, message: string, status?: number, details?: unknown) {
    super(message);
    this.name = "MarkovaError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
