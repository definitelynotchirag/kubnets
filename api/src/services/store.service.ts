import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import type { Store, StoreEngine } from "@urumi/shared";
import { enqueueProvision, enqueueDeletion } from "../workers/provisioner.worker.js";
import { logAudit } from "./audit.service.js";
import { StoreLimitReachedError, UnsupportedEngineError } from "../lib/errors.js";

/** Only WooCommerce is implemented in Round 1; Medusa exists to show the engine seam. */
const PROVISIONABLE_ENGINES: StoreEngine[] = ["woocommerce"];

function generateShortId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function toStoreResponse(record: {
  id: string;
  namespace: string;
  engine: string;
  status: string;
  url: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Store {
  return {
    id: record.id,
    namespace: record.namespace,
    engine: record.engine as StoreEngine,
    status: record.status as Store["status"],
    url: record.url,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export async function createStore(engine: StoreEngine, ipAddress?: string): Promise<Store> {
  if (!PROVISIONABLE_ENGINES.includes(engine)) {
    throw new UnsupportedEngineError(engine);
  }

  const count = await prisma.store.count({
    where: { status: { notIn: ["Deleting"] } },
  });

  if (count >= config.MAX_STORES) {
    throw new StoreLimitReachedError(config.MAX_STORES);
  }

  const shortId = generateShortId();
  const namespace = `store-${shortId}`;

  const record = await prisma.store.create({
    data: {
      namespace,
      engine,
      status: "Pending",
    },
  });

  logger.info({ storeId: record.id, namespace }, "Store created");
  await logAudit("store.created", record.id, `Engine: ${engine}, Namespace: ${namespace}`, ipAddress);
  enqueueProvision(record.id);

  return toStoreResponse(record);
}

export async function listStores(): Promise<Store[]> {
  const records = await prisma.store.findMany({
    orderBy: { createdAt: "desc" },
  });
  return records.map(toStoreResponse);
}

export async function getStore(id: string): Promise<Store | null> {
  const record = await prisma.store.findUnique({ where: { id } });
  return record ? toStoreResponse(record) : null;
}

export async function deleteStore(id: string, ipAddress?: string): Promise<Store | null> {
  const record = await prisma.store.findUnique({ where: { id } });
  if (!record) return null;

  // Already deleting: this is a retry request (typically after a failed or interrupted
  // cleanup), so push it back into the worker instead of ignoring it.
  if (record.status === "Deleting") {
    logger.info({ storeId: id, namespace: record.namespace }, "deletion_retry_requested");
    await logAudit("store.delete_requested", id, `Retry, namespace: ${record.namespace}`, ipAddress);
    enqueueDeletion(id);
    return toStoreResponse(record);
  }

  const updated = await prisma.store.update({
    where: { id },
    data: { status: "Deleting" },
  });

  logger.info({ storeId: id, namespace: record.namespace }, "Store marked for deletion");
  await logAudit("store.delete_requested", id, `Namespace: ${record.namespace}`, ipAddress);
  enqueueDeletion(id);

  return toStoreResponse(updated);
}
