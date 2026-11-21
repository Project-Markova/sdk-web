# @markova/sdk

Official MARKOVA tracking SDK for web and Node.js applications. Tracks events,
identifies users, manages sessions and devices, registers push tokens, and
handles batching, offline queuing and retries - so you never lose data.

## Install

```bash
npm install @markova/sdk
```

## Quick start

```typescript
import { Markova } from "@markova/sdk";

const markova = new Markova({
  apiKey: "YOUR_PROJECT_KEY", // mk_live_... from MARKOVA dashboard
  endpoint: "https://api.example.com",
});

await markova.identify("user_123", {
  name: "John",
  email: "john@example.com",
});

markova.track("Product Purchased", {
  productId: "product_1",
  price: 99,
});

await markova.flush();
```

## Features

- **Identification** - `identify(userId, traits)` links anonymous sessions to
  known users server-side (identity resolution happens in the backend).
- **Event tracking** - `track(eventName, properties)` with Zod validation;
  invalid events throw locally before hitting the network.
- **Session tracking** - 30-minute inactivity windows, persisted in
  `localStorage` (browser) with an anonymous id that survives reloads.
- **Device context** - platform, OS and device type are auto-detected and
  attached to every event (`WEB`/`ANDROID`/`IOS`/`OTHER`).
- **Push tokens** - `registerPushToken({ platform, pushToken })`.
- **Batching** - events are queued and flushed every 20 events or 5 seconds
  (configurable), sent as one `POST /api/v1/events/batch` call.
- **Offline queue** - network failures keep events queued (persisted to
  `localStorage` in browsers, capped at `maxQueueSize`).
- **Retries** - exponential backoff with jitter for network/5xx/429 errors;
  permanent 4xx rejections are dropped and reported via `onError`.
- **Experiments** - `await markova.assignExperiment("checkout-v2")` returns the
  deterministic A/B variant for the current user.
- **Notification preferences** - `updateNotificationPreferences([...])` and
  `unsubscribe("EMAIL")`.

## Configuration

| Option | Default | Description |
| ------ | ------- | ----------- |
| `apiKey` | - | Project API key (required) |
| `endpoint` | - | MARKOVA backend base URL (required) |
| `flushInterval` | `5000` | Auto-flush interval in ms (`0` disables) |
| `batchSize` | `20` | Events per batch request |
| `maxQueueSize` | `1000` | Offline queue cap |
| `maxRetries` | `3` | Retry attempts per batch |
| `persistQueue` | `true` | Persist queue to localStorage |
| `debug` | `false` | Verbose console logging |
| `onError` | - | Callback for validation/delivery errors |

## Development

```bash
npm install
npm run build      # tsup -> dist (ESM + CJS + types)
npm test           # vitest
npm run typecheck  # strict TypeScript
```

The package is built and published independently of the platform; it is not a
runtime service. `Dockerfile` exists for reproducible CI builds.
