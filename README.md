# unblur-meeting-service

Creates and ends video-call rooms for 1-on-1 resolution bookings via Daily.co. No database --
there is no `meet_rooms` table. `providerRoomId`, `joinUrl` and `expiresAt` are returned to the
caller (Resolution Service), which stores `joinUrl` on its own `bookings` row.

## Internal-only, no client-facing routes

Every route except `GET /healthz` requires header `X-Internal-Service-Token` matching the
`INTERNAL_SERVICE_TOKEN` env var. The service fails to start if this env var (or
`DAILY_API_KEY`) is unset -- fail closed, same as every other internal-token-gated service in
this project. This service never validates who is allowed to join a meeting (poster/resolver
membership) -- that's Resolution Service's job, since it owns the booking row. There is no
`GET /meetings/join/...`-style client-facing endpoint here at all.

## Provider

`src/provider/daily-provider.ts` defines a `VideoRoomProvider` interface (Strategy pattern, same
shape as Payment Service's `PaymentGateway`) so a different provider (Twilio/Jitsi/Zoom) could be
swapped in later without touching any route handler.

- `DailyVideoProvider` -- the real implementation, calls Daily.co's REST API with `DAILY_API_KEY`
  (read from env, never logged). Throws on any non-2xx response, including Daily's own error text
  so failures are debuggable.
- `FakeVideoProvider` -- deterministic in-memory fake used in tests, no network call.

## Room naming and expiry

Room names are `{type}-{referenceId}-{randomHex}` -- the `referenceId` (a UUID) is already fairly
unguessable on its own, but a random component is appended too so a room name is never derivable
purely from knowing/enumerating a reference id (the exact "guessable room name" concern flagged
when Daily/Jitsi were chosen as the provider).

`expiresAt` is `now + durationMins + 15 minutes` -- the 15 minute buffer exists so a call in
progress isn't cut off exactly at the scheduled slot end.

## Create vs. end: opposite failure philosophies, on purpose

- `POST /internal/rooms` hard-fails (`502`) if the provider call throws. A booking with no real
  room behind it is a real problem the caller needs to see and retry.
- `POST /internal/rooms/:id/end` degrades gracefully -- if the provider call fails (e.g. the room
  already expired or was cleaned up naturally), it logs a warning and still returns
  `200 { ok: true }`. A booking being marked complete shouldn't block on successfully tearing down
  a room that may already be gone.

## Recording

Not wired up in this version -- Recording & Moderation Service (a later version) will add
`enable_recording` (and related config) to the `properties` object passed at room-creation time
in `daily-provider.ts`. A comment marks where that goes.

## Local development

```bash
cp .env.example .env.local
npm install
npm run dev
```

## Scripts

- `npm run dev` -- local dev server
- `npm run build` -- production build
- `npm test` -- unit tests (Vitest)
