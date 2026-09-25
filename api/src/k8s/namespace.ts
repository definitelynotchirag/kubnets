import { setTimeout as sleep } from "node:timers/promises";
import { coreApi } from "./client.js";
import { config } from "../config.js";
import { ensureObject } from "./ensure.js";
import { isAlreadyExists, isNotFound } from "./errors.js";
import { logger } from "../lib/logger.js";

const NAMESPACE_LABELS = {
  "app.kubernetes.io/managed-by": "urumi",
  "app.kubernetes.io/part-of": "urumi",
};

const RESOURCE_QUOTA_NAME = "store-quota";
const LIMIT_RANGE_NAME = "store-limits";

function resourceQuotaBody() {
  return {
    metadata: { name: RESOURCE_QUOTA_NAME },
    spec: {
      hard: {
        "requests.cpu": "2",
        "requests.memory": "2Gi",
        pods: "10",
        persistentvolumeclaims: "4",
        // Size cap as well as a count cap: without this a store could request arbitrarily large
        // volumes and fill the node's storage.
        "requests.storage": config.STORE_STORAGE_QUOTA,
      },
    },
  };
}

function limitRangeBody() {
  return {
    metadata: { name: LIMIT_RANGE_NAME },
    spec: {
      limits: [
        {
          type: "Container",
          _default: { cpu: "250m", memory: "256Mi" },
          defaultRequest: { cpu: "50m", memory: "64Mi" },
        },
      ],
    },
  };
}

/**
 * Namespaces are cluster-scoped, so they cannot go through `ensureObject` (which is namespaced).
 * The desired state is just "exists", which makes this a different, simpler operation.
 */
export async function ensureNamespace(name: string): Promise<{ created: boolean }> {
  try {
    await coreApi.readNamespace({ name });
    logger.debug({ namespace: name }, "namespace_ensured");
    return { created: false };
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  try {
    await coreApi.createNamespace({
      body: { metadata: { name, labels: NAMESPACE_LABELS } },
    });
  } catch (err) {
    // Lost a race with another reconciliation run: the namespace now exists, which is the
    // desired state.
    if (!isAlreadyExists(err)) throw err;
    return { created: false };
  }

  logger.info({ namespace: name }, "namespace_created");
  return { created: true };
}

export async function ensureResourceQuota(namespace: string): Promise<{ created: boolean }> {
  return ensureObject({
    kind: "ResourceQuota",
    namespace,
    name: RESOURCE_QUOTA_NAME,
    body: resourceQuotaBody,
    read: () =>
      coreApi.readNamespacedResourceQuota({ name: RESOURCE_QUOTA_NAME, namespace }),
    create: () =>
      coreApi.createNamespacedResourceQuota({ namespace, body: resourceQuotaBody() }),
    replace: (body) =>
      coreApi.replaceNamespacedResourceQuota({
        name: RESOURCE_QUOTA_NAME,
        namespace,
        body,
      }),
  });
}

export async function ensureLimitRange(namespace: string): Promise<{ created: boolean }> {
  return ensureObject({
    kind: "LimitRange",
    namespace,
    name: LIMIT_RANGE_NAME,
    body: limitRangeBody,
    read: () => coreApi.readNamespacedLimitRange({ name: LIMIT_RANGE_NAME, namespace }),
    create: () => coreApi.createNamespacedLimitRange({ namespace, body: limitRangeBody() }),
    replace: (body) =>
      coreApi.replaceNamespacedLimitRange({ name: LIMIT_RANGE_NAME, namespace, body }),
  });
}

export async function deleteNamespace(name: string): Promise<{ deleted: boolean }> {
  try {
    await coreApi.deleteNamespace({ name });
    logger.info({ namespace: name }, "namespace_deletion_requested");
    return { deleted: true };
  } catch (err) {
    if (isNotFound(err)) {
      logger.info({ namespace: name }, "namespace_already_absent");
      return { deleted: false };
    }
    throw err;
  }
}

/**
 * Namespace deletion is asynchronous and can stall on finalizers (a PVC still in use, a stuck
 * pod). Waiting for the namespace to actually disappear is what lets the platform report a
 * truthful deletion instead of a 404 store with orphaned resources.
 */
export async function waitForNamespaceDeletion(
  name: string,
  timeoutMs = 120_000,
  intervalMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      await coreApi.readNamespace({ name });
    } catch (err) {
      if (isNotFound(err)) {
        logger.info({ namespace: name, attempts }, "namespace_deleted");
        return;
      }
      throw err;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `namespace "${name}" still exists after ${Math.round(timeoutMs / 1000)}s ` +
      `(check for finalizers, stuck pods or volumes still in use)`
  );
}
