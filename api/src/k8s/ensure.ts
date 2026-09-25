import { isAlreadyExists, isNotFound, statusCodeOf } from "./errors.js";
import { logger } from "../lib/logger.js";

interface KubernetesObject {
  metadata?: { resourceVersion?: string; name?: string };
}

export interface EnsureObjectOptions<T extends KubernetesObject> {
  /** Kind, for logs and error messages. */
  kind: string;
  namespace: string;
  name: string;
  /** Desired spec, without `metadata` (the helper adds name + resourceVersion). */
  body: () => { metadata?: { name?: string }; [key: string]: unknown };
  read: () => Promise<T>;
  create: () => Promise<unknown>;
  replace: (body: Record<string, unknown>) => Promise<unknown>;
}

/** How many optimistic-concurrency conflicts to absorb before giving up. */
const MAX_REPLACE_ATTEMPTS = 3;

/**
 * Converges one namespaced object to its desired state: create it if missing, otherwise update
 * it to the desired spec. Safe to call on every provisioning run, which is the whole point.
 *
 * Why PUT (`replace`) instead of PATCH:
 * `@kubernetes/client-node` 1.x sends PATCH requests as `application/json-patch+json` (first in
 * its media-type preference list), while these desired states are merge-patch documents — the API
 * server would reject a JSON object where it expects a JSON Patch array. A replace is also
 * stricter about convergence: fields that are no longer part of the desired state actually go
 * away, which a merge patch would leave behind.
 *
 * The update carries the `resourceVersion` read from the server (optimistic concurrency, i.e.
 * what `kubectl replace` does). A concurrent writer therefore produces a 409 rather than a lost
 * update; we re-read and retry a bounded number of times, and recreate the object if it vanished
 * in the meantime.
 */
export async function ensureObject<T extends KubernetesObject>(
  options: EnsureObjectOptions<T>
): Promise<{ created: boolean }> {
  const log = { kind: options.kind, namespace: options.namespace, name: options.name };

  let existing: T | undefined;
  try {
    existing = await options.read();
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  if (!existing) {
    try {
      await options.create();
      logger.info(log, "resource_created");
      return { created: true };
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      logger.debug(log, "resource_created_concurrently");
      return { created: false };
    }
  }

  for (let attempt = 1; attempt <= MAX_REPLACE_ATTEMPTS; attempt += 1) {
    const body = {
      ...options.body(),
      metadata: {
        ...options.body().metadata,
        name: options.name,
        resourceVersion: existing.metadata?.resourceVersion,
      },
    };

    try {
      await options.replace(body);
      logger.info(log, "resource_ensured");
      return { created: false };
    } catch (err) {
      if (isNotFound(err)) {
        // Deleted between the read and the replace: the desired state is "exists", so create it.
        await options.create();
        logger.info(log, "resource_recreated");
        return { created: true };
      }

      if (statusCodeOf(err) === 409 && attempt < MAX_REPLACE_ATTEMPTS) {
        logger.debug({ ...log, attempt }, "resource_replace_conflict");
        existing = await options.read();
        continue;
      }

      throw err;
    }
  }

  throw new Error(
    `${options.kind} "${options.name}" in namespace "${options.namespace}" kept changing during update`
  );
}
