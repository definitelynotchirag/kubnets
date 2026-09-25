import pLimit from "p-limit";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { provisionStore, deprovisionStore } from "../services/provisioner.service.js";

const limit = pLimit(config.MAX_CONCURRENT_PROVISIONS);

export function enqueueProvision(storeId: string): void {
  logger.info({ storeId }, "Enqueuing store provisioning");
  limit(() => provisionStore(storeId)).catch((err) => {
    logger.error({ storeId, error: err }, "Provisioning task failed unexpectedly");
  });
}

export function enqueueDeletion(storeId: string): void {
  logger.info({ storeId }, "Enqueuing store deletion");
  limit(() => deprovisionStore(storeId)).catch((err) => {
    logger.error({ storeId, error: err }, "Deletion task failed unexpectedly");
  });
}
