import path from "node:path";
import { existsSync } from "node:fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import * as pinoHttpModule from "pino-http";
const pinoHttp = (pinoHttpModule as any).default || pinoHttpModule;
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { storesRouter } from "./routes/stores.js";
import { errorHandler } from "./middleware/error-handler.js";
import { getAuditLogs } from "./services/audit.service.js";
import { getMetrics } from "./services/metrics.service.js";
import { reconcileStaleStores } from "./services/reconciliation.service.js";
import { generalLimiter } from "./middleware/rate-limit.js";

const app = express();

app.set("trust proxy", 1);
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(
  pinoHttp({
    logger,
    // Readiness/liveness probes hit /api/health every few seconds; logging them buries the
    // lifecycle events that actually matter (provisioning, reconciliation, failures).
    autoLogging: { ignore: (req: { url?: string }) => req.url === "/api/health" },
  })
);
app.use("/api", generalLimiter);

// Routes
app.use("/api/stores", storesRouter);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Global audit logs
app.get("/api/audit-logs", async (_req, res, next) => {
  try {
    const logs = await getAuditLogs(undefined, 100);
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

// Metrics endpoint
app.get("/api/metrics", async (_req, res, next) => {
  try {
    const metrics = await getMetrics();
    res.json(metrics);
  } catch (err) {
    next(err);
  }
});

// Serve dashboard static files if present (production / docker-compose)
const dashboardPath = path.resolve(
  process.env.DASHBOARD_PATH || path.join(import.meta.dirname, "../../dashboard/dist")
);
if (existsSync(dashboardPath)) {
  logger.info({ dashboardPath }, "Serving dashboard static files");
  app.use(express.static(dashboardPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(dashboardPath, "index.html"));
  });
}

// Error handler
app.use(errorHandler);

// Graceful shutdown
function shutdown(signal: string): void {
  logger.info({ signal }, "Shutting down...");
  prisma.$disconnect().then(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Start server
app.listen(config.PORT, async () => {
  logger.info({ port: config.PORT }, "API server started");
  try {
    await reconcileStaleStores();
  } catch (err) {
    logger.error({ err }, "reconciliation_failed");
  }
});
