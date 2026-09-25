#!/usr/bin/env node
/**
 * RBAC coverage check.
 *
 * The API provisions stores by running Helm from inside a pod, using its own ServiceAccount.
 * If the ClusterRole is missing a kind that the store chart renders, provisioning fails at
 * install time with `forbidden` — in production, at the worst possible moment. This script
 * compares the two without needing a cluster:
 *
 *   1. render charts/store (a full WooCommerce store) and collect the kinds it creates,
 *   2. render helm/platform and collect the API ClusterRole's rules,
 *   3. assert every rendered kind is covered with the verbs Helm needs.
 *
 * Run: node scripts/check-rbac-coverage.mjs
 */
import { execFileSync } from "node:child_process";

/** Kubernetes kind -> (apiGroup, resource). Mirrors the API groups used by the store chart. */
const KIND_TO_RESOURCE = {
  Namespace: ["", "namespaces"],
  Secret: ["", "secrets"],
  ConfigMap: ["", "configmaps"],
  Service: ["", "services"],
  ServiceAccount: ["", "serviceaccounts"],
  PersistentVolumeClaim: ["", "persistentvolumeclaims"],
  ResourceQuota: ["", "resourcequotas"],
  LimitRange: ["", "limitranges"],
  Pod: ["", "pods"],
  Deployment: ["apps", "deployments"],
  StatefulSet: ["apps", "statefulsets"],
  ReplicaSet: ["apps", "replicasets"],
  DaemonSet: ["apps", "daemonsets"],
  Job: ["batch", "jobs"],
  CronJob: ["batch", "cronjobs"],
  Ingress: ["networking.k8s.io", "ingresses"],
  NetworkPolicy: ["networking.k8s.io", "networkpolicies"],
  PodDisruptionBudget: ["policy", "poddisruptionbudgets"],
};

/** Kinds the API never creates directly: read access is enough to implement `helm --wait`. */
const READ_ONLY_KINDS = new Set(["Pod"]);

function helmTemplate(chart, extraArgs = []) {
  return execFileSync("helm", ["template", "check", chart, ...extraArgs], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Kinds present in a rendered Helm output. `kind:` is emitted at column 0 by `helm template`. */
function kindsIn(rendered) {
  return new Set(
    [...rendered.matchAll(/^kind:\s+(\S+)$/gm)].map((match) => match[1])
  );
}

/** Minimal parser for the ClusterRole rules we render (line based, tolerant of line wrapping). */
function clusterRoleRules(rendered) {
  const document = rendered
    .split(/\n---\n/)
    .find((doc) => doc.includes("kind: ClusterRole") && !doc.includes("ClusterRoleBinding"));
  if (!document) throw new Error("no ClusterRole found in the rendered platform chart");

  const rules = [];
  let current = null;
  let collecting = null;

  for (const line of document.split("\n")) {
    if (/^\s*-\s+apiGroups:/.test(line)) {
      if (current) rules.push(current);
      current = { apiGroups: [], resources: [], verbs: [] };
      collecting = "apiGroups";
      line.replace(/\[(.*)\]/, (_match, inner) => {
        // NOTE: the core API group is the empty string, so it must survive the split/filter.
        if (inner.trim() !== "") {
          current.apiGroups.push(...inner.split(",").map((s) => s.trim().replace(/"/g, "")));
        }
        return "";
      });
      continue;
    }
    if (!current) continue;

    if (/^\s*resources:/.test(line)) {
      collecting = "resources";
      if (line.includes("]")) collecting = null;
      current.resources.push(...(line.match(/"([^"]+)"/g) ?? []).map((s) => s.replace(/"/g, "")));
      continue;
    }
    if (/^\s*verbs:/.test(line)) {
      collecting = "verbs";
      if (line.includes("]")) collecting = null;
      current.verbs.push(...(line.match(/"([^"]+)"/g) ?? []).map((s) => s.replace(/"/g, "")));
      continue;
    }
    if (collecting) {
      current[collecting].push(...(line.match(/"([^"]+)"/g) ?? []).map((s) => s.replace(/"/g, "")));
      if (line.includes("]")) collecting = null;
    }
  }
  if (current) rules.push(current);
  return rules;
}

function actionFor(group, resource, rules) {
  return rules.find((rule) => rule.apiGroups.includes(group) && rule.resources.includes(resource));
}

const storeKinds = kindsIn(helmTemplate("charts/store", ["-f", "charts/store/values-local.yaml"]));
const platform = helmTemplate("helm/platform", ["-f", "helm/platform/values-local.yaml"]);
const rules = clusterRoleRules(platform);

const failures = [];
const checked = [];

for (const kind of [...storeKinds].sort()) {
  const mapping = KIND_TO_RESOURCE[kind];
  if (!mapping) {
    failures.push(`${kind}: rendered by charts/store but not mapped in KIND_TO_RESOURCE`);
    continue;
  }
  const [group, resource] = mapping;
  const rule = actionFor(group, resource, rules);
  if (!rule) {
    failures.push(`${kind} (${group || "core"}/${resource}): no ClusterRole rule covers it`);
    continue;
  }

  const required = READ_ONLY_KINDS.has(kind) ? ["get", "list", "watch"] : ["get", "list", "watch", "create", "update", "patch", "delete"];
  const missing = required.filter((verb) => !rule.verbs.includes(verb));
  if (missing.length > 0) {
    failures.push(`${kind} (${group || "core"}/${resource}): missing verbs ${missing.join(", ")}`);
    continue;
  }
  checked.push(`${resource} [${rule.verbs.join("/")}]`);
}

// Guardrails: no wildcards and no cluster-admin shortcut.
for (const rule of rules) {
  if (rule.resources.includes("*") || rule.apiGroups.includes("*") || rule.verbs.includes("*")) {
    failures.push(`ClusterRole contains a wildcard rule: ${JSON.stringify(rule)}`);
  }
}

if (failures.length > 0) {
  console.error("RBAC coverage check FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`RBAC coverage check passed for ${checked.length} resource types:`);
for (const entry of checked) console.log(`  - ${entry}`);
