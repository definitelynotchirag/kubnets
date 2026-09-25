import { networkingApi } from "./client.js";
import { logger } from "../lib/logger.js";

export async function createNetworkPolicies(namespace: string): Promise<void> {
  // Default deny all ingress
  await networkingApi.createNamespacedNetworkPolicy({
    namespace,
    body: {
      metadata: { name: "default-deny-ingress" },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress"],
      },
    },
  });

  // Allow ingress from nginx ingress controller
  await networkingApi.createNamespacedNetworkPolicy({
    namespace,
    body: {
      metadata: { name: "allow-ingress-controller" },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress"],
        ingress: [
          {
            _from: [
              {
                namespaceSelector: {
                  matchLabels: {
                    "kubernetes.io/metadata.name": "ingress-nginx",
                  },
                },
              },
            ],
          },
        ],
      },
    },
  });

  // Allow internal communication within namespace (WordPress <-> MariaDB)
  await networkingApi.createNamespacedNetworkPolicy({
    namespace,
    body: {
      metadata: { name: "allow-internal" },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress"],
        ingress: [
          {
            _from: [
              {
                podSelector: {},
              },
            ],
          },
        ],
      },
    },
  });

  logger.info({ namespace }, "Network policies created");
}
