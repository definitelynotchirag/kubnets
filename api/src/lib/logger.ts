import { createRequire } from "node:module";
import pino from "pino";

const require = createRequire(import.meta.url);

/**
 * pino-pretty is a development convenience only (it is not a runtime dependency of the
 * production image). Fall back to plain JSON logs instead of crashing when it is absent.
 */
function prettyTransport() {
  if (process.env.NODE_ENV === "production") return undefined;
  try {
    require.resolve("pino-pretty");
    return { target: "pino-pretty", options: { colorize: true } };
  } catch {
    return undefined;
  }
}

export const logger = pino({
  transport: prettyTransport(),
  level: process.env.LOG_LEVEL || "info",
});
