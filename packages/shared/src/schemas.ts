import { z } from "zod";

export const storeEngineSchema = z.enum(["woocommerce", "medusa"]);

export const storeStatusSchema = z.enum([
  "Pending",
  "Provisioning",
  "Ready",
  "Failed",
  "Deleting",
]);

export const createStoreSchema = z.object({
  engine: storeEngineSchema,
});

export const storeIdParamSchema = z.object({
  id: z.string().uuid(),
});
