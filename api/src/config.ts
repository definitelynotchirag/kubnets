import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3001),
  KUBECONFIG: z.string().default(""),
  STORE_DOMAIN: z.string().default("localtest.me"),
  HELM_CHART_PATH_WOOCOMMERCE: z.string().default("./charts/store"),
  HELM_CHART_PATH_MEDUSA: z.string().default("./charts/medusa-store"),
  HELM_VALUES_PROFILE: z.enum(["local", "prod"]).default("local"),
  MAX_STORES: z.coerce.number().default(5),
  MAX_CONCURRENT_PROVISIONS: z.coerce.number().default(3),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
