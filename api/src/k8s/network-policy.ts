import type { V1NetworkPolicy } from "@kubernetes/client-node";
import { networkingApi } from "./client.js";
import { ensureObject } from "./ensure.js";
import { logger } from "../lib/logger.js";

export interface NetworkPolicyOptions {
  /** Namespace the platform (API) itself runs in; needed for the post-provision HTTP probe. */
  platformNamespace: string;
  /** Namespace of the ingress controller that must be able to route to the store. */
  ingressNamespace: string;
}

/**
 * Store namespaces start from a default-deny posture and then allow exactly three flows:
 * the ingress controller, pods inside the store namespace (WordPress <-> MariaDB), and the
 * platform API performing its readiness probe. Every policy is ensured (create or replace),
 * never blindly created, so a provisioning retry converges instead of failing on AlreadyExists.
 */
export async function ensureNetworkPolicies(
  namespace: string,
  options: NetworkPolicyOptions
): Promise<{ created: number; existing: number }> {
  const policies: Array<{ name: string; spec: V1NetworkPolicy["spec"] }> = [
    {
      name: "default-deny-ingress",
      spec: { podSelector: {}, policyTypes: ["Ingress"] },
    },
    {
      name: "allow-ingress-controller",
      spec: {
        podSelector: {},
        policyTypes: ["Ingress"],
        ingress: [
          {
            _from: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": options.ingressNamespace },
                },
              },
            ],
          },
        ],
      },
    },
    {
      name: "allow-internal",
      spec: {
        podSelector: {},
        policyTypes: ["Ingress"],
        ingress: [{ _from: [{ podSelector: {} }] }],
      },
    },
    {
      // Lets the platform API reach the storefront Service directly (in-cluster probe)
      // without exposing the store to every other tenant namespace.
      name: "allow-platform-ingress",
      spec: {
        podSelector: {},
        policyTypes: ["Ingress"],
        ingress: [
          {
            _from: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": options.platformNamespace },
                },
              },
            ],
          },
        ],
      },
    },
  ];

  let created = 0;
  let existing = 0;

  for (const policy of policies) {
    const body = () => ({
      metadata: { name: policy.name },
      spec: policy.spec as Record<string, unknown>,
    });

    const result = await ensureObject({
      kind: "NetworkPolicy",
      namespace,
      name: policy.name,
      body,
      read: () =>
        networkingApi.readNamespacedNetworkPolicy({ name: policy.name, namespace }) as Promise<V1NetworkPolicy>,
      create: () => networkingApi.createNamespacedNetworkPolicy({ namespace, body: body() }),
      replace: (replaceBody) =>
        networkingApi.replaceNamespacedNetworkPolicy({
          name: policy.name,
          namespace,
          body: replaceBody,
        }),
    });

    result.created ? (created += 1) : (existing += 1);
  }

  logger.info({ namespace, created, existing }, "network_policies_ensured");
  return { created, existing };
}
