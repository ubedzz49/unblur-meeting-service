import { buildApp } from "./app.js";
import { DailyVideoProvider } from "./provider/daily-provider.js";
import { logger } from "./logger.js";

const port = Number(process.env.PORT ?? 3007);

// fail closed, same philosophy as JWT_SECRET in the gateway -- an unset internal token would
// otherwise mean this service silently accepts any request to /internal/*
if (!process.env.INTERNAL_SERVICE_TOKEN) {
  logger.fatal("INTERNAL_SERVICE_TOKEN is not set, refusing to start");
  process.exit(1);
}

if (!process.env.DAILY_API_KEY) {
  logger.fatal("DAILY_API_KEY is not set, refusing to start");
  process.exit(1);
}

// not fail-closed like the two above -- auto-recording is an enhancement (the room and its
// manual record button still work without it), not something the whole service depends on to
// function. The /webhooks/daily route itself rejects every request while this is unset.
if (!process.env.DAILY_WEBHOOK_SECRET) {
  logger.warn("DAILY_WEBHOOK_SECRET is not set, incoming Daily webhooks will be rejected");
}

const app = buildApp(new DailyVideoProvider());

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info({ port }, "meeting-service listening"))
  .catch((err) => {
    logger.error({ err }, "meeting-service failed to start");
    process.exit(1);
  });
