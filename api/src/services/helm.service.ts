import { execa } from "execa";
import { config } from "../config.js";
import { coreApi } from "../k8s/client.js";
import { logger } from "../lib/logger.js";
import type { StoreEngine } from "@urumi/shared";

function getChartPath(engine: StoreEngine): string {
  return engine === "medusa"
    ? config.HELM_CHART_PATH_MEDUSA
    : config.HELM_CHART_PATH_WOOCOMMERCE;
}

function getValuesFile(): string {
  return config.HELM_VALUES_PROFILE === "prod" ? "values-prod.yaml" : "values-local.yaml";
}

/**
 * Helm records an in-flight operation in the release itself. If the API dies mid-install (or
 * mid-upgrade), the release is left in `pending-*` and every later `helm upgrade --install`
 * fails with "another operation (install/upgrade/rollback) is in progress" - so a provisioning
 * retry after a crash would never converge. Reading the phase is a precondition for recovering.
 */
async function helmReleasePhase(
  releaseName: string,
  namespace: string
): Promise<string | null> {
  try {
    const result = await execa(config.HELM_BIN, [
      "status",
      releaseName,
      "--namespace",
      namespace,
      "--output",
      "json",
    ]);
    const parsed = JSON.parse(result.stdout) as { info?: { status?: string } };
    return parsed.info?.status ?? null;
  } catch {
    return null;
  }
}

export interface UpgradeInstallOptions {
  releaseName: string;
  namespace: string;
  hostname: string;
  engine: StoreEngine;
  /** Name of the Kubernetes Secret holding the store credentials. */
  secretName: string;
}

/**
 * Engine-specific values.
 *
 * Credentials are referenced by secret name instead of being passed with `--set`:
 * `helm --set` values (including anything that looks like a password) are stored verbatim in
 * the release Secret, so injecting them here would leak every store's DB password to anyone
 * who can read `sh.helm.release.*`. The chart consumes `existingSecret` instead.
 */
function getEngineSetArgs(
  engine: StoreEngine,
  hostname: string,
  secretName: string
): string[] {
  if (engine === "woocommerce") {
    return [
      "--set", `wordpress.ingress.hostname=${hostname}`,
      // Keeps WordPress's own notion of the scheme in step with the URL the platform reports.
      "--set", `wordpress.wordpressScheme=${config.STORE_URL_SCHEME}`,
      "--set", `wordpress.existingSecret=${secretName}`,
      "--set", `wordpress.mariadb.auth.existingSecret=${secretName}`,
      // The WooCommerce init hook Job reads its DB password / secret name from values too,
      // so it must follow STORE_SECRET_NAME as well.
      "--set", `woocommerceInit.existingSecret=${secretName}`,
    ];
  }

  // MedusaJS engine (architecture stub — see DESIGN.md)
  return [
    "--set", `medusa.ingress.hostname=${hostname}`,
    "--set", `postgresql.auth.existingSecret=${secretName}`,
    "--set", `redis.auth.existingSecret=${secretName}`,
  ];
}

/**
 * Releases the Helm lock left behind by a crashed provisioning run.
 *
 * - `pending-install`: nothing is deployed yet, so the incomplete release is removed and the
 *   upgrade below starts clean.
 * - `pending-upgrade` / `pending-rollback`: a working revision may already exist, so prefer
 *   rolling back to it (which releases the lock without destroying the store), falling back to
 *   an uninstall only if no deployed revision is available.
 */
async function clearStaleHelmOperation(releaseName: string, namespace: string): Promise<void> {
  const phase = await helmReleasePhase(releaseName, namespace);
  if (!phase || !phase.startsWith("pending")) return;

  logger.warn({ releaseName, namespace, phase }, "stale_helm_operation_recovering");

  if (phase === "pending-upgrade" || phase === "pending-rollback") {
    try {
      await execa(
        config.HELM_BIN,
        ["rollback", releaseName, "--namespace", namespace, "--wait", "--timeout", config.HELM_TIMEOUT],
        { timeout: 15 * 60 * 1000 }
      );
      logger.info({ releaseName, namespace, phase }, "stale_helm_operation_rolled_back");
      return;
    } catch (err) {
      logger.warn({ releaseName, namespace, err }, "helm_rollback_failed_falling_back_to_uninstall");
    }
  }

  await helmUninstall(releaseName, namespace);
  logger.info({ releaseName, namespace, phase }, "stale_helm_operation_uninstalled");
}

/**
 * `upgrade --install` is the whole idempotency story on the Helm side: a fresh store installs,
 * a store whose release already exists reconciles, and a store whose API crashed between
 * `helm install` and the database update converges instead of failing with
 * "cannot re-use a name that is still in use".
 */
export async function helmUpgradeInstall(options: UpgradeInstallOptions): Promise<void> {
  const chartPath = getChartPath(options.engine);
  const args = [
    "upgrade",
    "--install",
    options.releaseName,
    chartPath,
    "--namespace",
    options.namespace,
    "--wait",
    "--wait-for-jobs",
    "--timeout",
    config.HELM_TIMEOUT,
    "--history-max",
    "10",
    "-f",
    `${chartPath}/${getValuesFile()}`,
    ...getEngineSetArgs(options.engine, options.hostname, options.secretName),
  ];

  await clearStaleHelmOperation(options.releaseName, options.namespace);

  logger.info(
    {
      releaseName: options.releaseName,
      namespace: options.namespace,
      hostname: options.hostname,
      engine: options.engine,
      secretName: options.secretName,
      profile: config.HELM_VALUES_PROFILE,
      valuesFile: getValuesFile(),
    },
    "helm_upgrade_install_started"
  );

  const result = await execa(config.HELM_BIN, args, { timeout: 15 * 60 * 1000 });
  logger.debug({ stdout: result.stdout }, "helm_upgrade_install_completed");
}

export async function helmUninstall(releaseName: string, namespace: string): Promise<void> {
  logger.info({ releaseName, namespace }, "helm_uninstall_started");

  try {
    // Deliberately no `--wait`: uninstalling waits for every release resource - including hook
    // Jobs - to disappear, and a hook Job that is still retrying can hold that for many minutes.
    // The namespace deletion that follows is the authoritative cleanup, and it is verified by
    // waitForNamespaceDeletion(), so waiting twice only risks a needless deletion failure.
    await execa(
      config.HELM_BIN,
      ["uninstall", releaseName, "--namespace", namespace, "--timeout", config.HELM_TIMEOUT],
      { timeout: 15 * 60 * 1000 }
    );
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (
      stderr.includes("not found") ||
      stderr.includes("no deployed releases") ||
      stderr.includes("release: not found")
    ) {
      logger.info({ releaseName, namespace }, "helm_release_already_absent");
      return;
    }
    throw err;
  }
}

export async function helmStatus(releaseName: string, namespace: string): Promise<string> {
  const result = await execa(config.HELM_BIN, [
    "status",
    releaseName,
    "--namespace",
    namespace,
    "--output",
    "json",
  ]);
  return result.stdout;
}

/** Used by deletion so that a re-run of `deprovisionStore` is a no-op instead of an error. */
export async function helmReleaseExists(releaseName: string, namespace: string): Promise<boolean> {
  try {
    await execa(config.HELM_BIN, [
      "status",
      releaseName,
      "--namespace",
      namespace,
      "--output",
      "json",
    ]);
    return true;
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (stderr.includes("not found") || stderr.includes("no deployed releases")) {
      return false;
    }
    logger.warn({ releaseName, namespace, err }, "helm_release_lookup_failed");
    // Worst case we try to uninstall a release that does not exist, which is tolerated.
    return true;
  }
}

const INIT_JOB_CONTAINER = "woocommerce-init";

/**
 * Turns "post-install hooks failed" into something a human can act on: the tail of the
 * WooCommerce init Job's container log. Best effort by design — never fail provisioning
 * because log collection failed.
 */
export async function getInitJobFailureLogs(
  namespace: string,
  releaseName: string
): Promise<string | null> {
  try {
    const pods = await coreApi.listNamespacedPod({
      namespace,
      labelSelector: `job-name=${releaseName}-woocommerce-init`,
    });

    for (const pod of pods.items ?? []) {
      const container =
        pod.spec?.containers?.find((c) => c.name === INIT_JOB_CONTAINER) ??
        pod.spec?.containers?.[0];
      const name = pod.metadata?.name;
      if (!name || !container) continue;

      const log = await coreApi.readNamespacedPodLog({
        name,
        namespace,
        container: container.name,
        tailLines: 20,
      });
      if (typeof log === "string" && log.trim().length > 0) {
        return log.trim().slice(-4000);
      }
    }
  } catch (err) {
    logger.debug({ namespace, releaseName, err }, "init_job_log_collection_failed");
  }

  return null;
}
