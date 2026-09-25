import { prisma } from "../lib/prisma.js";

export async function getMetrics() {
  const [stores, recentFailures, auditLogs] = await Promise.all([
    prisma.store.groupBy({
      by: ["status"],
      _count: { status: true },
    }),
    prisma.store.count({
      where: {
        status: "Failed",
        updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
    // Get provisioning durations from audit logs (created -> ready)
    prisma.$queryRaw<{ avg_ms: number | null }[]>`
      SELECT AVG(EXTRACT(EPOCH FROM (ready.created_at - created.created_at)) * 1000) as avg_ms
      FROM audit_logs ready
      JOIN audit_logs created ON ready.store_id = created.store_id
      WHERE ready.action = 'store.ready'
        AND created.action = 'store.created'
        AND ready.created_at > NOW() - INTERVAL '24 hours'
    `,
  ]);

  const byStatus: Record<string, number> = {};
  let totalStores = 0;
  for (const row of stores) {
    byStatus[row.status] = row._count.status;
    totalStores += row._count.status;
  }

  return {
    totalStores,
    byStatus,
    provisioningDurationAvgMs: Math.round(auditLogs[0]?.avg_ms ?? 0),
    recentFailures,
  };
}
