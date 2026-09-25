import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import {
  deleteNamespace,
  ensureLimitRange,
  ensureNamespace,
  ensureResourceQuota,
  waitForNamespaceDeletion,
} from "../k8s/namespace.js";
import { ensureNetworkPolicies } from "../k8s/network-policy.js";
import { ensureStoreSecrets } from "../k8s/secrets.js";
import { waitForStoreHttp } from "../k8s/readiness.js";
import {
  getInitJobFailureLogs,
  helmReleaseExists,
  helmUninstall,
  helmUpgradeInstall,
} from "./helm.service.js";
import { logAudit } from "./audit.service.js";
import { storeEngineSchema } from "@urumi/shared";
import type { StoreEngine, StoreStatus } from "@urumi/shared";

/** Only WooCommerce is implemented in Round 1 — Medusa is an architectural stub. */
const IMPLEMENTED_ENGINES: StoreEngine[] = ["woocommerce"];

/**
 * Status updates are written with `updateMany` on purpose: a store can be deleted from the
 * database while provisioning is in flight, and a missing row must not turn a successful
 * converge into a crash.
 *
 * `skipIfDeleting` protects the one race that actually matters: a delete request arriving
 * mid-provision must not be overwritten by the later `Ready` transition. Deletion-failure
 * handling deliberately omits the guard, because it *is* the transition for that row.
 */
async function setStoreStatus(
  storeId: string,
  data: { status?: StoreStatus; url?: string | null; errorMessage?: string | null },
  options: { skipIfDeleting?: boolean } = {}
): Promise<boolean> {
  const { count } = await prisma.store.updateMany({
    where: options.skipIfDeleting
      ? { id: storeId, status: { not: "Deleting" } }
      : { id: storeId },
    data,
  });
  if (count === 0) {
    logger.info({ storeId, requested: data.status ?? "update" }, "store_status_transition_skipped");
  }
  return count > 0;
}

/**
 * Converges a store to "provisioned". Every step is an ensure/upgrade operation, so calling
 * this twice (crash recovery, manual retry, startup reconciliation) reaches the same state:
 * no duplicate resources, no rotated credentials, no Helm release conflicts.
 */
export async function provisionStore(storeId: string): Promise<void> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    logger.warn({ storeId }, "Store not found for provisioning");
    return;
  }

  // Never fight a deletion that is already in progress.
  if (store.status === "Deleting") {
    logger.info({ storeId }, "provision_skipped_deleting");
    return;
  }

  // The engine is a persisted blob: validate it rather than trusting the DB column type.
  const parsedEngine = storeEngineSchema.safeParse(store.engine);
  if (!parsedEngine.success || !IMPLEMENTED_ENGINES.includes(parsedEngine.data)) {
    const errorMessage = `Engine "${store.engine}" cannot be provisioned in Round 1 (architecture stub).`;
    logger.error({ storeId, engine: store.engine }, "provisioning_failed_unsupported_engine");
    await setStoreStatus(storeId, { status: "Failed", errorMessage }, { skipIfDeleting: true });
    await logAudit("store.failed", storeId, errorMessage);
    return;
  }

  const engine: StoreEngine = parsedEngine.data;

  if (store.status !== "Provisioning") {
    await setStoreStatus(storeId, { status: "Provisioning", errorMessage: null }, { skipIfDeleting: true });
    await logAudit("store.provisioning", storeId, `Engine: ${engine}`);
  }

  const namespace = store.namespace;
  const releaseName = namespace;
  const hostname = `${namespace}.${config.STORE_DOMAIN}`;
  let step = "ensure_namespace";

  logger.info({ storeId, namespace, hostname, engine }, "provisioning_started");

  try {
    await ensureNamespace(namespace);

    step = "ensure_resource_quota";
    await ensureResourceQuota(namespace);

    step = "ensure_limit_range";
    await ensureLimitRange(namespace);

    step = "ensure_network_policies";
    await ensureNetworkPolicies(namespace, {
      platformNamespace: config.PLATFORM_NAMESPACE,
      ingressNamespace: config.INGRESS_NAMESPACE,
    });

    await logAudit(
      "store.namespace_ready",
      storeId,
      `Namespace ${namespace} with resource quota (2 CPU / 2Gi), container limits and network policies`
    );

    step = "ensure_credentials";
    const secrets = await ensureStoreSecrets(namespace, config.STORE_SECRET_NAME);
    await logAudit(
      "store.credentials_ready",
      storeId,
      secrets.reused
        ? "Reused the existing credentials (a retry never rotates a live store's passwords)"
        : "Generated per-store database and WordPress credentials"
    );

    step = "helm_upgrade_install";
    await logAudit(
      "store.helm_started",
      storeId,
      `helm upgrade --install ${releaseName} (${config.HELM_VALUES_PROFILE} profile) - waiting for WordPress, MariaDB and the WooCommerce initialization job`
    );
    await helmUpgradeInstall({
      releaseName,
      namespace,
      hostname,
      engine,
      secretName: secrets.secretName,
    });
    await logAudit(
      "store.helm_ready",
      storeId,
      "WordPress, MariaDB and the WooCommerce initialization job all reported ready by Helm"
    );

    // Helm already waited for the workloads and for the WooCommerce init Job; this probe is
    // what makes `Ready` mean "the storefront actually answers HTTP requests".
    step = "verify_storefront";
    await logAudit(
      "store.verifying",
      storeId,
      `Probing ${hostname} over HTTP before marking the store ready`
    );
    await waitForStoreHttp({
      namespace,
      releaseName,
      hostname,
      timeoutMs: config.READY_VERIFY_TIMEOUT_MS,
      intervalMs: config.READY_VERIFY_INTERVAL_MS,
    });

    const url = `${config.STORE_URL_SCHEME}://${hostname}`;
    const updated = await setStoreStatus(
      storeId,
      { status: "Ready", url, errorMessage: null },
      { skipIfDeleting: true }
    );
    logger.info({ storeId, namespace, url }, "provisioning_succeeded");
    if (updated) {
      await logAudit("store.ready", storeId, `URL: ${url}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ storeId, namespace, step, error: message }, "provisioning_failed");

    let errorMessage = `provisioning failed during ${step}: ${message}`;
    if (step === "helm_upgrade_install") {
      const initLogs = await getInitJobFailureLogs(namespace, releaseName);
      if (initLogs) {
        errorMessage += `\n--- woocommerce-init job log (tail) ---\n${initLogs}`;
      }
    }

    await setStoreStatus(storeId, { status: "Failed", errorMessage }, { skipIfDeleting: true });
    await logAudit("store.failed", storeId, errorMessage);
  }
}

/**
 * Deletion is convergent too: a missing Helm release and a missing namespace are expected
 * states, not errors, so an interrupted deletion can simply be re-run.
 */
export async function deprovisionStore(storeId: string): Promise<void> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) {
    logger.warn({ storeId }, "Store not found for deprovisioning");
    return;
  }

  const namespace = store.namespace;
  const releaseName = namespace;

  logger.info({ storeId, namespace }, "deletion_started");

  try {
    if (await helmReleaseExists(releaseName, namespace)) {
      await helmUninstall(releaseName, namespace);
      await logAudit("store.helm_uninstalled", storeId, `Helm release ${releaseName} removed`);
    } else {
      logger.info({ releaseName, namespace }, "helm_release_absent");
      await logAudit("store.helm_uninstalled", storeId, "No Helm release to remove");
    }

    // Deleting the namespace cascades pods, services, ingresses, secrets and claims.
    // Whether the underlying volume is released depends on the StorageClass reclaim policy.
    await deleteNamespace(namespace);
    // Confirmed deletion, not just requested: a store is only removed from the database once
    // its Kubernetes resources are really gone.
    await waitForNamespaceDeletion(namespace, config.DELETE_TIMEOUT_MS, config.DELETE_POLL_INTERVAL_MS);
    await logAudit(
      "store.namespace_deleted",
      storeId,
      `Namespace ${namespace} confirmed gone (pods, services, ingress, secrets and claims removed)`
    );

    // Audited before the row disappears: the audit table references the store, so the entry
    // has to be written while that FK target still exists.
    await logAudit("store.deleted", storeId, `Namespace: ${namespace}`);
    await prisma.store.deleteMany({ where: { id: storeId } });

    logger.info({ storeId, namespace }, "deletion_succeeded");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ storeId, namespace, error: message }, "deletion_failed");

    // `Failed` is the terminal, inspectable state for both provisioning and deletion
    // failures. Two paths still retry cleanup: a repeated DELETE request moves the store
    // back to `Deleting`, and a crash *before* this catch leaves the row in `Deleting`,
    // which startup reconciliation re-enqueues.
    await setStoreStatus(storeId, { status: "Failed", errorMessage: `Deletion failed: ${message}` });
  }
}
