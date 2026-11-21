import type { EventContext, Platform } from "./types";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export class SessionTracker {
  private anonymousId: string;
  private sessionId: string;
  private lastActivity: number;

  constructor() {
    this.anonymousId = this.restore("markova:anonymousId") ?? randomId();
    this.sessionId = this.restore("markova:sessionId") ?? randomId();
    this.lastActivity = Number(this.restore("markova:lastActivity") ?? 0);
    this.touch();
  }

  getAnonymousId(): string {
    return this.anonymousId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  // A new session starts after 30 minutes of inactivity.
  touch(): void {
    const now = Date.now();
    if (now - this.lastActivity > SESSION_TIMEOUT_MS) {
      this.sessionId = randomId();
    }
    this.lastActivity = now;
    this.persist("markova:anonymousId", this.anonymousId);
    this.persist("markova:sessionId", this.sessionId);
    this.persist("markova:lastActivity", String(this.lastActivity));
  }

  reset(): void {
    this.anonymousId = randomId();
    this.sessionId = randomId();
    this.lastActivity = Date.now();
    this.touch();
  }

  private restore(key: string): string | null {
    try {
      if (typeof localStorage !== "undefined") return localStorage.getItem(key);
    } catch {
      /* ignore */
    }
    return null;
  }

  private persist(key: string, value: string): void {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  }
}

export function detectContext(sessionId: string): EventContext {
  const context: EventContext = { sessionId, platform: "OTHER" };
  if (typeof navigator !== "undefined" && typeof window !== "undefined") {
    context.platform = "WEB";
    context.os = detectOs(navigator.userAgent);
    context.device = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "Mobile" : "Desktop";
  } else {
    context.platform = "OTHER";
    context.device = "Server";
  }
  return context;
}

function detectOs(userAgent: string): string {
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Mac OS X/i.test(userAgent)) return "macOS";
  if (/Android/i.test(userAgent)) return "Android";
  if (/iPhone|iPad|iOS/i.test(userAgent)) return "iOS";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "Unknown";
}

export function platformFromString(value: string | undefined): Platform {
  if (value === "WEB" || value === "ANDROID" || value === "IOS") return value;
  return "OTHER";
}
