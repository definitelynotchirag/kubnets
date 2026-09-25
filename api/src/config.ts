import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3001),
  KUBECONFIG: z.string().default(""),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Store addressing
  STORE_DOMAIN: z.string().default("localtest.me"),
  // http locally, https once the ingress has a TLS certificate attached.
  STORE_URL_SCHEME: z.enum(["http", "https"]).default("http"),

  // Store charts
  HELM_CHART_PATH_WOOCOMMERCE: z.string().default("./charts/store"),
  HELM_CHART_PATH_MEDUSA: z.string().default("./charts/medusa-store"),
  HELM_VALUES_PROFILE: z.enum(["local", "prod"]).default("local"),

  // Helm CLI
  HELM_BIN: z.string().default("helm"),
  HELM_TIMEOUT: z.string().default("10m"),

  // Namespaces the store namespaces must accept traffic from
  PLATFORM_NAMESPACE: z.string().default("urumi-system"),
  INGRESS_NAMESPACE: z.string().default("ingress-nginx"),

  // Credentials
  STORE_SECRET_NAME: z.string().default("store-credentials"),

  // Post-provision readiness verification. Always runs — `Ready` must mean "the storefront
  // answered an HTTP request". Only the target and the timing are configurable.
  //   service -> probe the store's in-cluster Service (API runs inside the cluster)
  //   ingress -> probe the ingress from outside the cluster (e.g. docker-compose),
  //              using STORE_PROBE_INGRESS_HOST as the address to dial
  STORE_PROBE_MODE: z.enum(["service", "ingress"]).default("service"),
  STORE_PROBE_INGRESS_HOST: z.string().default(""),
  READY_VERIFY_TIMEOUT_MS: z.coerce.number().default(180_000),
  READY_VERIFY_INTERVAL_MS: z.coerce.number().default(5_000),

  // Deletion confirmation (namespace actually gone before the record is removed)
  DELETE_TIMEOUT_MS: z.coerce.number().default(120_000),
  DELETE_POLL_INTERVAL_MS: z.coerce.number().default(2_000),

  // Abuse controls
  MAX_STORES: z.coerce.number().default(5),
  // Blast-radius cap on how much storage one store can claim across all of its PVCs. The store
  // chart asks for 2x10Gi in the prod profile, so the cap leaves headroom above a real store
  // while still bounding a runaway claim.
  STORE_STORAGE_QUOTA: z.string().default("32Gi"),
  MAX_CONCURRENT_PROVISIONS: z.coerce.number().default(3),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
