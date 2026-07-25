import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "./app.js";
import { FakeVideoProvider } from "./provider/daily-provider.js";

const INTERNAL_TOKEN = "test-internal-token";
const REFERENCE_ID = "11111111-1111-1111-1111-111111111111";

function newApp(provider = new FakeVideoProvider()) {
  return { app: buildApp(provider, INTERNAL_TOKEN), provider };
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    type: "resolution",
    referenceId: REFERENCE_ID,
    durationMins: 60,
    ...overrides,
  };
}

async function createRoom(app: ReturnType<typeof buildApp>, body: Record<string, unknown> = createBody(), headers: Record<string, string> = { "x-internal-service-token": INTERNAL_TOKEN }) {
  return app.inject({ method: "POST", url: "/internal/rooms", headers, payload: body });
}

describe("GET /healthz", () => {
  it("returns ok status with no auth required", async () => {
    const { app } = newApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("internal auth", () => {
  it("401s create-room with no internal token", async () => {
    const { app } = newApp();
    const res = await createRoom(app, createBody(), {});
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid internal service token" });
  });

  it("401s create-room with a wrong internal token", async () => {
    const { app } = newApp();
    const res = await createRoom(app, createBody(), { "x-internal-service-token": "wrong" });
    expect(res.statusCode).toBe(401);
  });

  it("401s end-room with no internal token", async () => {
    const { app } = newApp();
    const res = await app.inject({ method: "POST", url: "/internal/rooms/some-id/end" });
    expect(res.statusCode).toBe(401);
  });

  it("succeeds create-room with a valid token", async () => {
    const { app } = newApp();
    const res = await createRoom(app);
    expect(res.statusCode).toBe(201);
  });
});

describe("POST /internal/rooms", () => {
  it("rejects a type other than 'resolution'", async () => {
    const { app } = newApp();
    const res = await createRoom(app, createBody({ type: "seminar" }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/type must be one of/);
  });

  it("rejects a missing type", async () => {
    const { app } = newApp();
    const res = await createRoom(app, createBody({ type: undefined }));
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing referenceId", async () => {
    const { app } = newApp();
    const res = await createRoom(app, createBody({ referenceId: undefined }));
    expect(res.statusCode).toBe(400);
  });

  it("rejects an empty-string referenceId", async () => {
    const { app } = newApp();
    const res = await createRoom(app, createBody({ referenceId: "" }));
    expect(res.statusCode).toBe(400);
  });

  it("rejects durationMins = 0", async () => {
    const { app } = newApp();
    const res = await createRoom(app, createBody({ durationMins: 0 }));
    expect(res.statusCode).toBe(400);
  });

  it("rejects a negative durationMins", async () => {
    const { app } = newApp();
    const res = await createRoom(app, createBody({ durationMins: -5 }));
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-integer durationMins", async () => {
    const { app } = newApp();
    const res = await createRoom(app, createBody({ durationMins: 12.5 }));
    expect(res.statusCode).toBe(400);
  });

  it("rejects a durationMins over the 480 minute bound", async () => {
    const { app } = newApp();
    const res = await createRoom(app, createBody({ durationMins: 481 }));
    expect(res.statusCode).toBe(400);
  });

  it("accepts durationMins exactly at the 480 minute bound", async () => {
    const { app } = newApp();
    const res = await createRoom(app, createBody({ durationMins: 480 }));
    expect(res.statusCode).toBe(201);
  });

  it("rejects a non-numeric durationMins", async () => {
    const { app } = newApp();
    const res = await createRoom(app, createBody({ durationMins: "60" }));
    expect(res.statusCode).toBe(400);
  });

  it("rejects an empty body with Content-Type: application/json set", async () => {
    const { app } = newApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/rooms",
      headers: { "x-internal-service-token": INTERNAL_TOKEN, "content-type": "application/json" },
      payload: "",
    });
    // empty body parses to {} (the standing fix), then fails normal field validation, not a raw parser error
    expect(res.statusCode).toBe(400);
  });

  it("returns providerRoomId, joinUrl and expiresAt on success", async () => {
    const { app } = newApp();
    const res = await createRoom(app);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.providerRoomId).toBeTruthy();
    expect(body.joinUrl).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();
  });

  it("computes expiresAt as now + durationMins + the 15 minute buffer", async () => {
    const { app, provider } = newApp();
    const before = Date.now();
    const res = await createRoom(app, createBody({ durationMins: 60 }));
    const after = Date.now();
    expect(res.statusCode).toBe(201);

    const call = provider.calls.createRoom[0];
    const expiresAtMs = call.expiresAt.getTime();
    // 60 + 15 min buffer, allow for test execution time drift
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 75 * 60_000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + 75 * 60_000 + 1000);
  });

  it("builds a room name combining type, referenceId and a random component", async () => {
    const { app, provider } = newApp();
    await createRoom(app);
    const call = provider.calls.createRoom[0];
    expect(call.name.startsWith(`resolution-${REFERENCE_ID}-`)).toBe(true);
  });

  it("generates a genuinely different room name across two calls with the same referenceId", async () => {
    const { app, provider } = newApp();
    await createRoom(app);
    await createRoom(app);
    const [first, second] = provider.calls.createRoom;
    expect(first.name).not.toEqual(second.name);
  });

  it("returns 502 (not the raw provider error) when the provider throws on create", async () => {
    const provider = new FakeVideoProvider();
    provider.createRoom = async () => {
      throw new Error("daily create room failed: 500 internal provider error, secret-key-xyz");
    };
    const { app } = newApp(provider);
    const res = await createRoom(app);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "couldn't create the meeting room, try again" });
  });
});

describe("POST /internal/rooms/:id/end", () => {
  it("returns 200 ok after successfully ending a real room", async () => {
    const { app, provider } = newApp();
    const createRes = await createRoom(app);
    const { providerRoomId } = createRes.json();

    const res = await app.inject({
      method: "POST",
      url: `/internal/rooms/${providerRoomId}/end`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(provider.calls.endRoom).toEqual([providerRoomId]);
  });

  it("degrades gracefully (200 ok) when the provider throws on end, e.g. room already gone", async () => {
    const provider = new FakeVideoProvider();
    provider.endRoom = async () => {
      throw new Error("daily end room failed: 404 room not found");
    };
    const { app } = newApp(provider);

    const res = await app.inject({
      method: "POST",
      url: "/internal/rooms/some-already-expired-room/end",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("accepts an empty body with Content-Type: application/json set (no-body action route)", async () => {
    const { app } = newApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/rooms/some-id/end",
      headers: { "x-internal-service-token": INTERNAL_TOKEN, "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(200);
  });

  it("401s end-room with a wrong internal token", async () => {
    const { app } = newApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/rooms/some-id/end",
      headers: { "x-internal-service-token": "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /internal/rooms/:id/tokens", () => {
  const USER_ID = "22222222-2222-2222-2222-222222222222";

  function mintToken(
    app: ReturnType<typeof buildApp>,
    providerRoomId: string,
    body: Record<string, unknown> = { userId: USER_ID, joinUrl: "https://fake.daily.co/room-1", expiresAt: new Date(Date.now() + 60_000).toISOString() },
  ) {
    return app.inject({
      method: "POST",
      url: `/internal/rooms/${providerRoomId}/tokens`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: body,
    });
  }

  it("401s with no internal token", async () => {
    const { app } = newApp();
    const res = await app.inject({ method: "POST", url: "/internal/rooms/room-1/tokens", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a missing userId", async () => {
    const { app } = newApp();
    const res = await mintToken(app, "room-1", { joinUrl: "https://fake.daily.co/room-1", expiresAt: new Date().toISOString() });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing joinUrl", async () => {
    const { app } = newApp();
    const res = await mintToken(app, "room-1", { userId: USER_ID, expiresAt: new Date().toISOString() });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid expiresAt", async () => {
    const { app } = newApp();
    const res = await mintToken(app, "room-1", { userId: USER_ID, joinUrl: "https://fake.daily.co/room-1", expiresAt: "not-a-date" });
    expect(res.statusCode).toBe(400);
  });

  it("returns a joinUrl tagged for the given user and records the call on the provider", async () => {
    const { app, provider } = newApp();
    const res = await mintToken(app, "room-1");
    expect(res.statusCode).toBe(200);
    expect(res.json().joinUrl).toBe("https://fake.daily.co/room-1?t=fake-token-22222222-2222-2222-2222-222222222222");
    expect(provider.calls.mintJoinToken).toEqual([{ providerRoomId: "room-1", userId: USER_ID }]);
  });

  it("returns 502 (not the raw provider error) when the provider throws", async () => {
    const provider = new FakeVideoProvider();
    provider.mintJoinToken = async () => {
      throw new Error("daily mint meeting token failed: 500 secret-key-xyz");
    };
    const { app } = newApp(provider);
    const res = await mintToken(app, "room-1");
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "couldn't mint a join link, try again" });
  });
});

describe("GET /internal/rooms/:id/attendance", () => {
  const USER_ID = "33333333-3333-3333-3333-333333333333";

  it("401s with no internal token", async () => {
    const { app } = newApp();
    const res = await app.inject({ method: "GET", url: `/internal/rooms/room-1/attendance?userId=${USER_ID}` });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a missing userId", async () => {
    const { app } = newApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/rooms/room-1/attendance",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 0 attended seconds when the provider has none recorded", async () => {
    const { app } = newApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/rooms/room-1/attendance?userId=${USER_ID}`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providerRoomId: "room-1", userId: USER_ID, attendedSeconds: 0 });
  });

  it("returns the attended seconds the provider reports for that user", async () => {
    const provider = new FakeVideoProvider();
    provider.attendedSeconds.set(`room-1:${USER_ID}`, 1800);
    const { app } = newApp(provider);
    const res = await app.inject({
      method: "GET",
      url: `/internal/rooms/room-1/attendance?userId=${USER_ID}`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().attendedSeconds).toBe(1800);
  });
});

describe("POST /webhooks/daily", () => {
  const WEBHOOK_SECRET = Buffer.from("test-webhook-secret").toString("base64");

  function newAppWithWebhook(provider = new FakeVideoProvider()) {
    return { app: buildApp(provider, INTERNAL_TOKEN, WEBHOOK_SECRET), provider };
  }

  function sign(secret: string, timestamp: string, rawBody: string): string {
    return crypto
      .createHmac("sha256", Buffer.from(secret, "base64"))
      .update(`${timestamp}.${rawBody}`)
      .digest("base64");
  }

  it("200s unverified when DAILY_WEBHOOK_SECRET is not configured yet (bootstrap window for registration)", async () => {
    const app = buildApp(new FakeVideoProvider(), INTERNAL_TOKEN, undefined);
    const res = await app.inject({ method: "POST", url: "/webhooks/daily", payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it("still starts recording unverified when DAILY_WEBHOOK_SECRET is not configured yet", async () => {
    const provider = new FakeVideoProvider();
    const app = buildApp(provider, INTERNAL_TOKEN, undefined);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/daily",
      payload: { type: "participant.joined", payload: { room_name: "room-1" } },
    });
    expect(res.statusCode).toBe(200);
    expect(provider.calls.startRecording).toEqual(["room-1"]);
  });

  it("401s a request with no signature headers", async () => {
    const { app } = newAppWithWebhook();
    const res = await app.inject({ method: "POST", url: "/webhooks/daily", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("401s a request with a wrong signature", async () => {
    const { app } = newAppWithWebhook();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/daily",
      headers: { "x-webhook-timestamp": "123", "x-webhook-signature": "wrong" },
      payload: { type: "participant.joined", payload: { room_name: "room-1" } },
    });
    expect(res.statusCode).toBe(401);
  });

  it("200s and starts recording for a correctly-signed participant.joined event", async () => {
    const { app, provider } = newAppWithWebhook();
    const timestamp = "1700000000";
    const rawBody = JSON.stringify({ type: "participant.joined", payload: { room_name: "room-1" } });
    const signature = sign(WEBHOOK_SECRET, timestamp, rawBody);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/daily",
      headers: {
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signature,
        "content-type": "application/json",
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(provider.calls.startRecording).toEqual(["room-1"]);
  });

  it("200s and does nothing for an event type it doesn't care about", async () => {
    const { app, provider } = newAppWithWebhook();
    const timestamp = "1700000000";
    const rawBody = JSON.stringify({ type: "participant.left", payload: { room_name: "room-1" } });
    const signature = sign(WEBHOOK_SECRET, timestamp, rawBody);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/daily",
      headers: {
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signature,
        "content-type": "application/json",
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(provider.calls.startRecording).toEqual([]);
  });

  it("still 200s even if starting the recording throws (best-effort, never fails the webhook)", async () => {
    const provider = new FakeVideoProvider();
    provider.startRecording = async () => {
      throw new Error("daily start recording failed: 500");
    };
    const { app } = newAppWithWebhook(provider);
    const timestamp = "1700000000";
    const rawBody = JSON.stringify({ type: "participant.joined", payload: { room_name: "room-1" } });
    const signature = sign(WEBHOOK_SECRET, timestamp, rawBody);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/daily",
      headers: {
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signature,
        "content-type": "application/json",
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
  });

  it("does not require the internal service token", async () => {
    const { app } = newAppWithWebhook();
    const timestamp = "1700000000";
    const rawBody = JSON.stringify({ type: "participant.joined", payload: { room_name: "room-1" } });
    const signature = sign(WEBHOOK_SECRET, timestamp, rawBody);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/daily",
      headers: {
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signature,
        "content-type": "application/json",
        // deliberately no x-internal-service-token
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
  });
});
