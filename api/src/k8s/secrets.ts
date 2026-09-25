import crypto from "node:crypto";
import { coreApi } from "./client.js";
import { logger } from "../lib/logger.js";

function generatePassword(length = 24): string {
  return crypto.randomBytes(length).toString("base64url").slice(0, length);
}

export interface StoreSecrets {
  secretName: string;
  mariadbRootPassword: string;
  mariadbPassword: string;
  wordpressPassword: string;
}

export async function createStoreSecrets(
  namespace: string
): Promise<StoreSecrets> {
  const secretName = "store-credentials";
  const mariadbRootPassword = generatePassword();
  const mariadbPassword = generatePassword();
  const wordpressPassword = generatePassword();

  await coreApi.createNamespacedSecret({
    namespace,
    body: {
      metadata: {
        name: secretName,
        labels: {
          "app.kubernetes.io/managed-by": "urumi",
        },
      },
      type: "Opaque",
      stringData: {
        "mariadb-root-password": mariadbRootPassword,
        "mariadb-password": mariadbPassword,
        "wordpress-password": wordpressPassword,
      },
    },
  });

  logger.info({ namespace, secretName }, "Store secrets created");

  return { secretName, mariadbRootPassword, mariadbPassword, wordpressPassword };
}
