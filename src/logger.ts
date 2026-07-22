import pino from "pino";

// used before the Fastify app exists (boot) -- the app's own request logger (also pino, via
// Fastify's built-in `logger` option) takes over once buildApp() runs
export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
