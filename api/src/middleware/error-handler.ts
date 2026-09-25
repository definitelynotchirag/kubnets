import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger.js";

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error({ error: err.message, stack: err.stack }, "Unhandled error");

  res.status(500).json({
    error: err.message || "Internal server error",
  });
}
