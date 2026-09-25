import { execa } from "execa";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import type { StoreSecrets } from "../k8s/secrets.js";
import type { StoreEngine } from "@urumi/shared";

const HELM_TIMEOUT = "10m";

function getChartPath(engine: StoreEngine): string {
  return engine === "medusa"
    ? config.HELM_CHART_PATH_MEDUSA
    : config.HELM_CHART_PATH_WOOCOMMERCE;
}

function getEngineSetArgs(
  engine: StoreEngine,
  hostname: string,
  secrets: StoreSecrets
): string[] {
  if (engine === "woocommerce") {
    return [
      "--set", `wordpress.ingress.hostname=${hostname}`,
      "--set", `wordpress.wordpressPassword=${secrets.wordpressPassword}`,
      "--set", `wordpress.mariadb.auth.rootPassword=${secrets.mariadbRootPassword}`,
      "--set", `wordpress.mariadb.auth.password=${secrets.mariadbPassword}`,
    ];
  }

  // MedusaJS engine
  return [
    "--set", `medusa.ingress.hostname=${hostname}`,
    "--set", `postgresql.auth.password=${secrets.mariadbPassword}`,
    "--set", `postgresql.auth.postgresPassword=${secrets.mariadbRootPassword}`,
  ];
}

export async function helmInstall(
  releaseName: string,
  namespace: string,
  hostname: string,
  secrets: StoreSecrets,
  engine: StoreEngine = "woocommerce"
): Promise<void> {
  const chartPath = getChartPath(engine);
  const valuesFile =
    config.HELM_VALUES_PROFILE === "prod" ? "values-prod.yaml" : "values-local.yaml";

  const args = [
    "install",
    releaseName,
    chartPath,
    "--namespace",
    namespace,
    "--wait",
    "--timeout",
    HELM_TIMEOUT,
    "-f",
    `${chartPath}/${valuesFile}`,
    ...getEngineSetArgs(engine, hostname, secrets),
  ];

  logger.info({ releaseName, namespace, hostname, engine }, "Installing Helm chart");

  const result = await execa("helm", args);
  logger.debug({ stdout: result.stdout }, "Helm install output");
}

export async function helmUninstall(
  releaseName: string,
  namespace: string
): Promise<void> {
  logger.info({ releaseName, namespace }, "Uninstalling Helm chart");

  try {
    await execa("helm", [
      "uninstall",
      releaseName,
      "--namespace",
      namespace,
      "--wait",
      "--timeout",
      HELM_TIMEOUT,
    ]);
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (stderr.includes("not found")) {
      logger.info({ releaseName }, "Helm release already uninstalled");
      return;
    }
    throw err;
  }
}

export async function helmStatus(
  releaseName: string,
  namespace: string
): Promise<string> {
  const result = await execa("helm", [
    "status",
    releaseName,
    "--namespace",
    namespace,
    "--output",
    "json",
  ]);
  return result.stdout;
}
