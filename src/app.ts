import crypto from "node:crypto";
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FakeVideoProvider, VideoRoomProvider } from "./provider/daily-provider.js";

const MAX_DURATION_MINS = 480;
// scheduled slot end plus a buffer so the call isn't cut off exactly at the booked end time --
// matches the "expiry = slot end plus buffer" rule from the design doc's security section
const EXPIRY_BUFFER_MINS = 15;

type RoomType = "resolution";
const VALID_ROOM_TYPES: RoomType[] = ["resolution"];

interface CreateRoomBody {
  type?: string;
  referenceId?: string;
  durationMins?: number;
}

export function buildApp(
  videoRoomProvider: VideoRoomProvider = new FakeVideoProvider(),
  internalServiceToken: string | undefined = process.env.INTERNAL_SERVICE_TOKEN,
): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : { level: process.env.LOG_LEVEL ?? "info" },
  });

  // Fastify's default JSON parser rejects an empty body when Content-Type: application/json is
  // set, even for no-body calls like POST .../end -- real clients send that header
  // unconditionally, so this bites any no-body call otherwise (see ARCHITECTURE_DECISIONS.md)
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
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
  // route except /healthz is gated on the shared service token, never a user identity header
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === "/healthz") return;
    const token = request.headers["x-internal-service-token"];
    if (!token || token !== internalServiceToken) {
      request.log.warn("rejected internal request with missing/invalid service token");
      return reply.code(401).send({ error: "invalid internal service token" });
    }
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

  return app;
}
