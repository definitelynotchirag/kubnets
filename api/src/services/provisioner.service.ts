import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { createNamespace, deleteNamespace } from "../k8s/namespace.js";
import { createNetworkPolicies } from "../k8s/network-policy.js";
import { createStoreSecrets } from "../k8s/secrets.js";
import { helmInstall, helmUninstall } from "./helm.service.js";
import type { StoreEngine } from "@urumi/shared";
import { logAudit } from "./audit.service.js";

export async function provisionStore(storeId: string): Promise<void> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    logger.warn({ storeId }, "Store not found for provisioning");
    return;
  }

  await prisma.store.update({
    where: { id: storeId },
    data: { status: "Provisioning" },
  });
  await logAudit("store.provisioning", storeId, `Engine: ${store.engine}`);

  try {
    const { namespace } = store;
    const hostname = `${namespace}.${config.STORE_DOMAIN}`;
    const releaseName = namespace;

    logger.info({ storeId, namespace }, "Starting store provisioning");

    // Step 1: Create namespace with quota/limits
    await createNamespace(namespace);

    // Step 2: Create network policies
    await createNetworkPolicies(namespace);

    // Step 3: Create secrets
    const secrets = await createStoreSecrets(namespace);

    // Step 4: Install Helm chart (includes --wait which polls readiness)
    await helmInstall(releaseName, namespace, hostname, secrets, store.engine as StoreEngine);

    // Step 5: Update store as ready
    const url = `http://${hostname}`;
    await prisma.store.update({
      where: { id: storeId },
      data: { status: "Ready", url, errorMessage: null },
    });

    logger.info({ storeId, namespace, url }, "Store provisioned successfully");
    await logAudit("store.ready", storeId, `URL: ${url}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ storeId, error: message }, "Store provisioning failed");

    await prisma.store.update({
      where: { id: storeId },
      data: { status: "Failed", errorMessage: message },
    });
    await logAudit("store.failed", storeId, message);
  }
}

export async function deprovisionStore(storeId: string): Promise<void> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    logger.warn({ storeId }, "Store not found for deprovisioning");
    return;
  }

  try {
    const { namespace } = store;
    const releaseName = namespace;

    logger.info({ storeId, namespace }, "Starting store deprovisioning");

    // Step 1: Uninstall Helm release
    await helmUninstall(releaseName, namespace);

    // Step 2: Delete namespace (cascades all resources)
    await deleteNamespace(namespace);

    // Step 3: Remove from database
    await prisma.store.delete({ where: { id: storeId } });

    logger.info({ storeId, namespace }, "Store deprovisioned successfully");
    await logAudit("store.deleted", storeId, `Namespace: ${namespace}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ storeId, error: message }, "Store deprovisioning failed");

    await prisma.store.update({
      where: { id: storeId },
      data: { status: "Failed", errorMessage: `Deletion failed: ${message}` },
    });
  }
}
