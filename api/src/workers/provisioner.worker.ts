import pLimit from "p-limit";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { provisionStore, deprovisionStore } from "../services/provisioner.service.js";

/**
 * In-memory provisioning queue.
 *
 * Two properties matter here:
 *
 * 1. `p-limit` bounds how many stores are provisioned at once (concurrent Helm runs are
 *    heavy, and every store gets its own namespace, database and volumes).
 * 2. Work for a *single* store is serialized by chaining onto that store's previous task.
 *    A delete requested while provisioning is running must not be dropped — it runs right
 *    after the provision finishes, and provisioning can no longer overwrite `Deleting`
 *    because its status transitions skip stores that are being deleted.
 *
 * This is a single-process queue: it does not coordinate across API replicas. See the scaling
 * section of DESIGN.md for what to replace it with (BullMQ / Kubernetes Jobs) before scaling
 * the API beyond one replica.
 */
const limit = pLimit(config.MAX_CONCURRENT_PROVISIONS);

/** Tail of the pending work chain per store. Entries disappear once a store's chain drains. */
const chains = new Map<string, Promise<void>>();

function enqueue(storeId: string, kind: "provision" | "delete", task: () => Promise<void>): void {
  const previous = chains.get(storeId) ?? Promise.resolve();

  const next = previous
    .catch(() => {
      // Failures are reported by the task itself; the chain must simply keep going.
    })
    .then(() =>
      limit(async () => {
        try {
          await task();
        } catch (err) {
          logger.error({ storeId, kind, error: err }, `${kind}_task_failed`);
        }
      })
    );

  chains.set(storeId, next);
  void next.then(() => {
    if (chains.get(storeId) === next) {
      chains.delete(storeId);
    }
  });
}

export function enqueueProvision(storeId: string): void {
  logger.info({ storeId, active: limit.activeCount, queued: limit.pendingCount }, "provision_enqueued");
  enqueue(storeId, "provision", () => provisionStore(storeId));
}

export function enqueueDeletion(storeId: string): void {
  logger.info({ storeId, active: limit.activeCount, queued: limit.pendingCount }, "deletion_enqueued");
  enqueue(storeId, "delete", () => deprovisionStore(storeId));
}
