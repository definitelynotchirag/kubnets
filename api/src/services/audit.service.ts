import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export type AuditAction =
  | "store.created"
  | "store.provisioning"
  | "store.ready"
  | "store.failed"
  | "store.delete_requested"
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
