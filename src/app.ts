import crypto from "node:crypto";
import Fastify, { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FakeVideoProvider, VideoRoomProvider } from "./provider/daily-provider.js";
import { logger } from "./logger.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

const MAX_DURATION_MINS = 480;
// scheduled slot end plus a buffer so the call isn't cut off exactly at the booked end time --
// matches the "expiry = slot end plus buffer" rule from the design doc's security section
const EXPIRY_BUFFER_MINS = 15;

type RoomType = "resolution" | "seminar" | "gd";
const VALID_ROOM_TYPES: RoomType[] = ["resolution", "seminar", "gd"];

interface CreateRoomBody {
  type?: string;
  referenceId?: string;
  durationMins?: number;
}

export function buildApp(
  videoRoomProvider: VideoRoomProvider = new FakeVideoProvider(),
  internalServiceToken: string | undefined = process.env.INTERNAL_SERVICE_TOKEN,
  dailyWebhookSecret: string | undefined = process.env.DAILY_WEBHOOK_SECRET,
): FastifyInstance {
  const app = Fastify(
    process.env.NODE_ENV === "test"
      ? { logger: false }
      : { loggerInstance: logger as unknown as FastifyBaseLogger },
  );

  // Fastify's default JSON parser rejects an empty body when Content-Type: application/json is
  // set, even for no-body calls like POST .../end -- real clients send that header
  // unconditionally, so this bites any no-body call otherwise (see ARCHITECTURE_DECISIONS.md).
  // Also stashes the raw string body on the request -- the Daily webhook route below needs it
  // (not the parsed object) to verify Daily's HMAC signature.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    request.rawBody = body as string;
    if (body === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  // this whole service is internal-only -- no client-facing routes exist here at all, so every
  // route except /healthz and the Daily webhook (verified separately below, by HMAC signature
  // instead -- Daily can't send our internal service token) is gated on the shared service
  // token, never a user identity header
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === "/healthz" || request.url.startsWith("/webhooks/")) return;
    const token = request.headers["x-internal-service-token"];
    if (!token || token !== internalServiceToken) {
      request.log.warn("rejected internal request with missing/invalid service token");
      return reply.code(401).send({ error: "invalid internal service token" });
    }
  });

  const VALID_LOG_LEVELS = ["info", "debug", "error"];

  // runtime-mutable logging verbosity, no redeploy needed -- see src/logger.ts for the custom
  // info<debug<error severity ordering this project uses (not pino's default trace<debug<info<
  // warn<error<fatal). Gated the same as every other /internal/ route.
  app.get("/internal/log-level", async (_request, reply) => {
    return reply.send({ level: logger.level });
  });

  app.post<{ Body: { level?: string } }>("/internal/log-level", async (request, reply) => {
    const { level } = request.body ?? {};
    if (typeof level !== "string" || !VALID_LOG_LEVELS.includes(level)) {
      return reply.code(400).send({ error: `level must be one of ${VALID_LOG_LEVELS.join(", ")}` });
    }
    logger.level = level;
    request.log.info({ level }, "log level changed at runtime");
    return reply.send({ level: logger.level });
  });

  app.post<{ Body: CreateRoomBody }>("/internal/rooms", async (request, reply) => {
    const { type, referenceId, durationMins } = request.body ?? {};

    if (typeof type !== "string" || !VALID_ROOM_TYPES.includes(type as RoomType)) {
      return reply.code(400).send({ error: `type must be one of ${VALID_ROOM_TYPES.join(", ")}` });
    }
    if (typeof referenceId !== "string" || referenceId.length === 0) {
      return reply.code(400).send({ error: "referenceId is required" });
    }
    if (
      typeof durationMins !== "number" ||
      !Number.isInteger(durationMins) ||
      durationMins <= 0 ||
      durationMins > MAX_DURATION_MINS
    ) {
      return reply.code(400).send({ error: `durationMins must be an integer between 1 and ${MAX_DURATION_MINS}` });
    }

    // referenceId (a UUID) is already fairly unguessable on its own, but a random component is
    // added too so a room name is never derivable from just knowing/enumerating a reference id
    const randomHex = crypto.randomBytes(8).toString("hex");
    const name = `${type}-${referenceId}-${randomHex}`;
    const expiresAt = new Date(Date.now() + (durationMins + EXPIRY_BUFFER_MINS) * 60_000);

    let result;
    try {
      result = await videoRoomProvider.createRoom({ name, expiresAt });
    } catch (err) {
      // hard-fail on create -- a booking with no real room is a real problem, unlike end-room's
      // graceful degradation below
      request.log.error({ err, referenceId }, "failed to create video room");
      return reply.code(502).send({ error: "couldn't create the meeting room, try again" });
    }

    request.log.info({ providerRoomId: result.providerRoomId, referenceId }, "video room created");
    return reply.code(201).send({
      providerRoomId: result.providerRoomId,
      joinUrl: result.joinUrl,
      expiresAt: expiresAt.toISOString(),
    });
  });

  app.post<{ Params: { id: string } }>("/internal/rooms/:id/end", async (request, reply) => {
    try {
      await videoRoomProvider.endRoom(request.params.id);
    } catch (err) {
      // a booking being marked complete shouldn't block on tearing down a room that may already
      // be gone/expired naturally -- log and degrade gracefully, opposite of create's hard-fail
      request.log.warn({ err, providerRoomId: request.params.id }, "failed to end video room, ignoring");
    }
    return reply.send({ ok: true });
  });

  // mints a join link tagged with a specific user id -- the shared/anonymous room joinUrl gives
  // Daily no way to attribute a session to a participant, which the attendance check below needs
  app.post<{ Params: { id: string }; Body: { userId?: string; joinUrl?: string; expiresAt?: string } }>(
    "/internal/rooms/:id/tokens",
    async (request, reply) => {
      const { userId, joinUrl, expiresAt } = request.body ?? {};
      if (typeof userId !== "string" || userId.length === 0) {
        return reply.code(400).send({ error: "userId is required" });
      }
      if (typeof joinUrl !== "string" || joinUrl.length === 0) {
        return reply.code(400).send({ error: "joinUrl is required" });
      }
      const parsedExpiresAt = new Date(expiresAt ?? "");
      if (Number.isNaN(parsedExpiresAt.getTime())) {
        return reply.code(400).send({ error: "expiresAt must be a valid ISO date string" });
      }

      let personalJoinUrl: string;
      try {
        personalJoinUrl = await videoRoomProvider.mintJoinToken(request.params.id, joinUrl, userId, parsedExpiresAt);
      } catch (err) {
        request.log.error({ err, providerRoomId: request.params.id, userId }, "failed to mint join token");
        return reply.code(502).send({ error: "couldn't mint a join link, try again" });
      }

      return reply.send({ joinUrl: personalJoinUrl });
    },
  );

  // sums a user's real time in the room, in seconds -- used at booking-completion time to decide
  // whether the resolver actually attended enough of the session to be paid
  app.get<{ Params: { id: string }; Querystring: { userId?: string } }>(
    "/internal/rooms/:id/attendance",
    async (request, reply) => {
      const { userId } = request.query ?? {};
      if (typeof userId !== "string" || userId.length === 0) {
        return reply.code(400).send({ error: "userId is required" });
      }

      const attendedSeconds = await videoRoomProvider.getAttendedSeconds(request.params.id, userId);
      return reply.send({ providerRoomId: request.params.id, userId, attendedSeconds });
    },
  );

  // Daily calls this the moment a participant joins a room -- enable_recording on room creation
  // only makes recording *available* (a manual button in Daily's UI), it doesn't auto-start it,
  // so this is what actually makes "every session is recorded" true without anyone clicking
  // anything. Verified by Daily's own HMAC signature (never trust an unverified webhook), not
  // the internal service token -- Daily has no way to send that.
  app.post("/webhooks/daily", async (request, reply) => {
    if (!dailyWebhookSecret) {
      // Deliberately not a 401 here: Daily's own webhook-registration call does a live
      // verification ping against this exact URL *before* it has ever handed us a secret to
      // verify against -- rejecting that ping makes registration itself impossible. Safe only
      // because this is a narrow, self-closing bootstrap window: DAILY_WEBHOOK_SECRET gets set
      // (from the value Daily's registration response returns) and redeployed immediately after
      // registration succeeds, closing this window for good.
      request.log.warn("DAILY_WEBHOOK_SECRET not configured yet, accepting unverified (bootstrap only)");
      const event = request.body as { type?: string; payload?: Record<string, unknown> };
      const roomName =
        (event.payload?.room_name as string | undefined) ??
        (event.payload?.room as string | undefined) ??
        (event.payload?.roomName as string | undefined);
      if (event.type === "participant.joined" && roomName) {
        try {
          await videoRoomProvider.startRecording(roomName);
        } catch (err) {
          request.log.warn({ err, roomName }, "failed to start recording, ignoring");
        }
      }
      return reply.code(200).send({ ok: true });
    }

    const timestamp = request.headers["x-webhook-timestamp"];
    const signature = request.headers["x-webhook-signature"];
    if (typeof timestamp !== "string" || typeof signature !== "string") {
      request.log.warn("rejected daily webhook: missing signature headers");
      return reply.code(401).send({ error: "missing signature headers" });
    }

    const expected = crypto
      .createHmac("sha256", Buffer.from(dailyWebhookSecret, "base64"))
      .update(`${timestamp}.${request.rawBody ?? ""}`)
      .digest("base64");

    if (signature !== expected) {
      request.log.warn("rejected daily webhook: signature mismatch");
      return reply.code(401).send({ error: "invalid signature" });
    }

    const event = request.body as { type?: string; payload?: Record<string, unknown> };
    const roomName =
      (event.payload?.room_name as string | undefined) ??
      (event.payload?.room as string | undefined) ??
      (event.payload?.roomName as string | undefined);

    if (event.type === "participant.joined" && roomName) {
      try {
        await videoRoomProvider.startRecording(roomName);
        request.log.info({ roomName }, "started recording on participant join");
      } catch (err) {
        // best-effort -- a recording that fails to start shouldn't affect the call itself, and
        // there's no user-facing action to retry from here anyway
        request.log.warn({ err, roomName }, "failed to start recording, ignoring");
      }
    }

    return reply.code(200).send({ ok: true });
  });

  return app;
}
