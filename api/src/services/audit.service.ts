import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export type AuditAction =
  | "store.created"
  | "store.provisioning"
  | "store.namespace_ready"
  | "store.credentials_ready"
  | "store.helm_started"
  | "store.helm_ready"
  | "store.verifying"
  | "store.ready"
  | "store.failed"
  | "store.delete_requested"
  | "store.helm_uninstalled"
  | "store.namespace_deleted"
  | "store.deleted";

export async function logAudit(
  action: AuditAction,
  storeId?: string,
  details?: string,
  ipAddress?: string
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { action, storeId, details, ipAddress },
    });
    logger.debug({ action, storeId }, "Audit log created");
  } catch (err) {
    logger.error({ action, storeId, err }, "Failed to create audit log");
  }
}

export async function getAuditLogs(storeId?: string, limit = 50) {
  return prisma.auditLog.findMany({
    where: storeId ? { storeId } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
