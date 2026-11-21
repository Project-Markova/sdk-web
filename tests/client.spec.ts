import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markova } from "../src/client";
import { MarkovaError } from "../src/types";
import { backoffDelay, classifyHttpError, isRetryable } from "../src/retry";

type FetchMock = ReturnType<typeof vi.fn>;

const jsonResponse = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeClient = (fetchMock: FetchMock, overrides: Record<string, unknown> = {}) =>
  new Markova({
    apiKey: "mk_live_testkeytestkeytestkey",
    endpoint: "https://api.test",
    flushInterval: 0,
    batchSize: 10,
    maxRetries: 3,
    persistQueue: false,
    ...overrides,
  });

describe("Markova SDK", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse(202, { accepted: true }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires an API key and endpoint", () => {
    expect(() => new Markova({ apiKey: "", endpoint: "https://x" } as never)).toThrow(MarkovaError);
    expect(() => new Markova({ apiKey: "k", endpoint: "" } as never)).toThrow(MarkovaError);
  });

  it("validates event names before sending", () => {
    const client = makeClient(fetchMock);
    expect(() => client.track("", {})).toThrow(/Validation failed/);
    expect(() => client.track("bad name !!", {})).toThrow(/Validation failed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends automatic timestamps and identity context", async () => {
    const client = makeClient(fetchMock, { batchSize: 1 });
    await client.identify("user_1", { name: "John", email: "john@example.com" });
    client.track("Product Purchased", { productId: "product_1", price: 99 });
    await client.flush();

    const identifyCall = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(identifyCall.userId).toBe("user_1");
    expect(identifyCall.anonymousId).toBeTruthy();

    const batchCall = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(batchCall.events).toHaveLength(1);
    const event = batchCall.events[0];
    expect(event.eventName).toBe("Product Purchased");
    expect(event.userId).toBe("user_1");
    expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
    expect(event.properties).toEqual({ productId: "product_1", price: 99 });
    expect(event.context.sessionId).toBeTruthy();
  });

  it("batches multiple events into one request", async () => {
    const client = makeClient(fetchMock);
    client.track("Event A");
    client.track("Event B");
    client.track("Event C");
    const result = await client.flush();
    expect(result.delivered).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events).toHaveLength(3);
  });

  it("retries transient network failures with backoff", async () => {
    fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(jsonResponse(202));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient(fetchMock, { batchSize: 1 });
    client.track("Event Retry");
    const result = await client.flush();

    expect(result.delivered).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(client.pendingEvents()).toBe(0);
  });

  it("keeps events queued when the network is down (offline queue)", async () => {
    fetchMock = vi.fn(async () => {
      throw new TypeError("offline");
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient(fetchMock, { batchSize: 1 });
    client.track("Offline Event");
    const result = await client.flush();

    expect(result.delivered).toBe(0);
    expect(result.queued).toBe(1);
    expect(client.pendingEvents()).toBe(1);
  });

  it("delivers queued events once connectivity returns", async () => {
    fetchMock = vi.fn(async () => {
      throw new TypeError("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = makeClient(fetchMock, { batchSize: 1 });
    client.track("Queued");
    await client.flush();

    fetchMock = vi.fn(async () => jsonResponse(202));
    vi.stubGlobal("fetch", fetchMock);
    const result = await client.flush();
    expect(result.delivered).toBe(1);
    expect(client.pendingEvents()).toBe(0);
  });

  it("drops permanently rejected batches and reports the error", async () => {
    fetchMock = vi.fn(async () => jsonResponse(422, { message: "Validation failed" }));
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();
    const client = makeClient(fetchMock, { batchSize: 1, onError });
    client.track("Invalid Event");
    const result = await client.flush();

    expect(result.failed).toBe(1);
    expect(client.pendingEvents()).toBe(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on rate limiting", async () => {
    fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(202));
    vi.stubGlobal("fetch", fetchMock);
    const client = makeClient(fetchMock, { batchSize: 1 });
    client.track("Rate Limited");
    const result = await client.flush();
    expect(result.delivered).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces auth errors without retrying", async () => {
    fetchMock = vi.fn(async () => jsonResponse(401, { message: "unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = makeClient(fetchMock, { batchSize: 1 });
    client.track("Auth Fail");
    const result = await client.flush();
    expect(result.failed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("flush is idempotent under concurrent calls", async () => {
    const client = makeClient(fetchMock, { batchSize: 1 });
    client.track("Concurrent");
    const [a, b] = await Promise.all([client.flush(), client.flush()]);
    expect(a).toBe(b);
    expect(a.delivered).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Retry helpers", () => {
  it("produces capped exponential backoff", () => {
    expect(backoffDelay(0)).toBeLessThan(1500);
    expect(backoffDelay(10)).toBeLessThanOrEqual(30_000);
  });

  it("classifies retryable and permanent errors", () => {
    expect(isRetryable(classifyHttpError(429))).toBe(true);
    expect(isRetryable(classifyHttpError(500))).toBe(true);
    expect(isRetryable(new MarkovaError("NETWORK_ERROR", "x"))).toBe(true);
    expect(isRetryable(classifyHttpError(401))).toBe(false);
    expect(isRetryable(classifyHttpError(422))).toBe(false);
  });
});
