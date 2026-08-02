import pino from "pino";

// used before the Fastify app exists (migrations, boot) -- the app's own request logger (also
// pino, via Fastify's built-in `logger` option) takes over once buildApp() runs. `logger.level`
// is intentionally mutable at runtime (not just read once from LOG_LEVEL at boot) -- see
// POST /internal/log-level in app.ts, which lets an admin change verbosity without a redeploy.
//
// Custom severity ordering, NOT pino's default (trace < debug < info < warn < error < fatal):
// here info < debug < error, per the project's logging-management convention --
//   LOG_LEVEL=info  -> shows info + debug + warn + error + fatal (the default, most verbose)
//   LOG_LEVEL=debug -> shows debug + warn + error + fatal (skips info)
//   LOG_LEVEL=error -> shows error + fatal only
// trace/warn/fatal keep their normal relative position; only info/debug/error's ordering changes.
const CUSTOM_LEVELS = { info: 15, debug: 35, error: 55 };

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  customLevels: CUSTOM_LEVELS,
});
