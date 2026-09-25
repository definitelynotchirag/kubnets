import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Startup reconciliation is the crash-recovery path: whatever was mid-flight when the process
 * died must be pushed back into the worker, and `Failed` stores must be left alone so they stay
 * inspectable instead of retrying forever.
 */

const state = vi.hoisted(() => ({
  byStatus: {
    Pending: [] as Array<{ id: string; namespace: string }>,
    Provisioning: [] as Array<{ id: string; namespace: string }>,
    Deleting: [] as Array<{ id: string; namespace: string }>,
  },
  failedCount: 0,
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    store: {
      findMany: vi.fn(async ({ where }: { where: { status: string } }) => {
        const key = where.status as keyof typeof state.byStatus;
        return state.byStatus[key] ?? [];
      }),
      count: vi.fn(async () => state.failedCount),
    },
  },
}));

const enqueueProvision = vi.hoisted(() => vi.fn());
const enqueueDeletion = vi.hoisted(() => vi.fn());

vi.mock("../workers/provisioner.worker.js", () => ({ enqueueProvision, enqueueDeletion }));

import { reconcileStaleStores } from "../services/reconciliation.service.js";

const pendingStore = { id: "11111111-1111-4111-8111-111111111111", namespace: "store-aaaa1111" };
const provisioningStore = { id: "22222222-2222-4222-8222-222222222222", namespace: "store-bbbb2222" };
const deletingStore = { id: "33333333-3333-4333-8333-333333333333", namespace: "store-cccc3333" };

describe("reconcileStaleStores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.byStatus = { Pending: [], Provisioning: [], Deleting: [] };
    state.failedCount = 0;
  });

  it("requeues Pending, Provisioning and Deleting stores and reports the counts", async () => {
    state.byStatus.Pending = [pendingStore];
    state.byStatus.Provisioning = [provisioningStore];
    state.byStatus.Deleting = [deletingStore];
    state.failedCount = 2;

    const summary = await reconcileStaleStores();

    expect(summary).toEqual({ pending: 1, provisioning: 1, deleting: 1, failed: 2 });
    // A Pending row is the crash window between "INSERT" and "worker starts" — it must be
    // provisioned, not left stuck forever.
    expect(enqueueProvision).toHaveBeenCalledWith(pendingStore.id);
    expect(enqueueProvision).toHaveBeenCalledWith(provisioningStore.id);
    expect(enqueueDeletion).toHaveBeenCalledWith(deletingStore.id);
    expect(enqueueDeletion).toHaveBeenCalledTimes(1);
  });

  it("never requeues failed stores", async () => {
    state.failedCount = 3;

    const summary = await reconcileStaleStores();

    expect(summary).toEqual({ pending: 0, provisioning: 0, deleting: 0, failed: 3 });
    expect(enqueueProvision).not.toHaveBeenCalled();
    expect(enqueueDeletion).not.toHaveBeenCalled();
  });
});
