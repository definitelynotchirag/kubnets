import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { enqueueDeletion, enqueueProvision } from "../workers/provisioner.worker.js";

export interface ReconciliationSummary {
  pending: number;
  provisioning: number;
  deleting: number;
  failed: number;
}

/**
 * Startup reconciliation: anything that was mid-flight when the process died gets pushed
 * back into the worker. `Failed` stores are intentionally left alone — they stay inspectable
 * and are cleaned up by an explicit delete, never by an automatic retry loop.
 */
export async function reconcileStaleStores(): Promise<ReconciliationSummary> {
  logger.info({}, "reconciliation_started");

  const pending = await prisma.store.findMany({ where: { status: "Pending" } });
  if (pending.length > 0) {
    logger.warn(
      { count: pending.length, storeIds: pending.map((store) => store.id) },
      "stale_pending_found"
    );
    for (const store of pending) {
      enqueueProvision(store.id);
      logger.info({ storeId: store.id, namespace: store.namespace }, "store_requeued");
    }
  }

  const provisioning = await prisma.store.findMany({ where: { status: "Provisioning" } });
  if (provisioning.length > 0) {
    logger.warn(
      { count: provisioning.length, storeIds: provisioning.map((store) => store.id) },
      "stale_provisioning_found"
    );
    for (const store of provisioning) {
      enqueueProvision(store.id);
      logger.info({ storeId: store.id, namespace: store.namespace }, "store_requeued");
    }
  }

  const deleting = await prisma.store.findMany({ where: { status: "Deleting" } });
  if (deleting.length > 0) {
    logger.warn(
      { count: deleting.length, storeIds: deleting.map((store) => store.id) },
      "stale_deleting_found"
    );
    for (const store of deleting) {
      enqueueDeletion(store.id);
      logger.info({ storeId: store.id, namespace: store.namespace }, "store_requeued");
    }
  }

  const failed = await prisma.store.count({ where: { status: "Failed" } });
  if (failed > 0) {
    logger.info({ count: failed }, "failed_stores_skipped");
  }

  const summary: ReconciliationSummary = {
    pending: pending.length,
    provisioning: provisioning.length,
    deleting: deleting.length,
    failed,
  };

  logger.info(summary, "reconciliation_complete");
  return summary;
}
