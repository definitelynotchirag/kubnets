import * as k8s from "@kubernetes/client-node";
import { coreApi } from "./client.js";
import { logger } from "../lib/logger.js";

export async function createNamespace(name: string): Promise<void> {
  try {
    await coreApi.readNamespace({ name });
    logger.info({ namespace: name }, "Namespace already exists");
    return;
  } catch {
    // Namespace doesn't exist, create it
  }

  await coreApi.createNamespace({
    body: {
      metadata: {
        name,
        labels: {
          "app.kubernetes.io/managed-by": "urumi",
          "app.kubernetes.io/part-of": "urumi",
        },
      },
    },
  });

  // Create ResourceQuota
  await coreApi.createNamespacedResourceQuota({
    namespace: name,
    body: {
      metadata: { name: "store-quota" },
      spec: {
        hard: {
          "requests.cpu": "2",
          "requests.memory": "2Gi",
          pods: "10",
          persistentvolumeclaims: "4",
        },
      },
    },
  });

  // Create LimitRange
  await coreApi.createNamespacedLimitRange({
    namespace: name,
    body: {
      metadata: { name: "store-limits" },
      spec: {
        limits: [
          {
            type: "Container",
            _default: { cpu: "250m", memory: "256Mi" },
            defaultRequest: { cpu: "50m", memory: "64Mi" },
          },
        ],
      },
    },
  });

  logger.info({ namespace: name }, "Namespace created with quota and limits");
}

export async function deleteNamespace(name: string): Promise<void> {
  try {
    await coreApi.deleteNamespace({ name });
    logger.info({ namespace: name }, "Namespace deleted");
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number } }).response
      ?.statusCode;
    if (status === 404) {
      logger.info({ namespace: name }, "Namespace already deleted");
      return;
    }
    throw err;
  }
}
