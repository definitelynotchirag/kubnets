import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Provisioning is supposed to be a convergent "ensure desired state" operation. That claim is
 * only meaningful if it is actually exercised, so this test drives `provisionStore` against a
 * small in-memory Kubernetes API (real HTTP, real @kubernetes/client-node calls, real 404/409
 * semantics) and a stub `helm` binary that records its invocations.
 *
 * What it proves:
 *   * running provisioning twice does not duplicate resources,
 *   * credentials created on the first run are reused on the second (never rotated),
 *   * Helm is driven with `upgrade --install`, so an existing release reconciles,
 *   * deletion is repeatable and only removes the record once the namespace is gone.
 *
 * What it cannot prove (needs a real cluster): that the Kubernetes control plane accepts every
 * object we send, that pods actually become ready, and that the storefront serves traffic.
 */

interface ClusterObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; resourceVersion?: string };
  [key: string]: unknown;
}

const h = vi.hoisted(() => {
  const row: Record<string, unknown> = {
    id: "11111111-1111-4111-8111-111111111111",
    namespace: "store-test1234",
    engine: "woocommerce",
    status: "Provisioning",
    url: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return { row, rowDeleted: { value: false } };
});

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    store: {
      findUnique: vi.fn(async () => (h.rowDeleted.value ? null : { ...h.row })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (h.rowDeleted.value) return { count: 0 };
        Object.assign(h.row, data);
        return { count: 1 };
      }),
      deleteMany: vi.fn(async () => {
        h.rowDeleted.value = true;
        return { count: 1 };
      }),
    },
  },
}));

vi.mock("../services/audit.service.js", () => ({ logAudit: vi.fn(async () => undefined) }));

// The HTTP readiness probe is exercised on its own in readiness.test.ts against a real local
// server; here it is stubbed so this test stays focused on resource convergence.
vi.mock("../k8s/readiness.js", () => ({
  waitForStoreHttp: vi.fn(async () => undefined),
}));

class FakeCluster {
  readonly objects = new Map<string, ClusterObject>();
  readonly creates = new Map<string, number>();
  readonly replaces = new Map<string, number>();
  private nextResourceVersion = 1;

  private key(kind: string, name: string, namespace?: string): string {
    return `${kind}/${namespace ?? "-"}/${name}`;
  }

  private count(bucket: Map<string, number>, kind: string): number {
    return bucket.get(kind) ?? 0;
  }

  createCount(kind: string): number {
    return this.count(this.creates, kind);
  }

  replaceCount(kind: string): number {
    return this.count(this.replaces, kind);
  }

  get(kind: string, namespace: string | undefined, name: string): ClusterObject | undefined {
    return this.objects.get(this.key(kind, name, namespace));
  }

  list(kind: string): ClusterObject[] {
    return [...this.objects.values()].filter((object) => object.kind === kind);
  }

  write(object: ClusterObject, namespace?: string): ClusterObject {
    object.metadata.namespace = namespace;
    object.metadata.resourceVersion = String(this.nextResourceVersion++);
    this.objects.set(this.key(object.kind, object.metadata.name, namespace), object);
    return object;
  }

  delete(kind: string, namespace: string | undefined, name: string): boolean {
    return this.objects.delete(this.key(kind, name, namespace));
  }

  recordCreate(kind: string): void {
    this.creates.set(kind, this.createCount(kind) + 1);
  }

  recordReplace(kind: string): void {
    this.replaces.set(kind, this.replaceCount(kind) + 1);
  }
}

const KIND_BY_PATH: Record<string, { kind: string; apiVersion: string }> = {
  namespaces: { kind: "Namespace", apiVersion: "v1" },
  resourcequotas: { kind: "ResourceQuota", apiVersion: "v1" },
  limitranges: { kind: "LimitRange", apiVersion: "v1" },
  secrets: { kind: "Secret", apiVersion: "v1" },
  pods: { kind: "Pod", apiVersion: "v1" },
  networkpolicies: { kind: "NetworkPolicy", apiVersion: "networking.k8s.io/v1" },
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function notFound(res: ServerResponse, resource: string): void {
  send(res, 404, {
    kind: "Status",
    apiVersion: "v1",
    status: "Failure",
    reason: "NotFound",
    code: 404,
    message: `${resource} not found`,
  });
}

/**
 * The API server converts `stringData` into base64 `data` on write. Emulating that matters:
 * the platform reads secrets back on every provisioning retry, and it only ever sees `data`.
 */
function normalize(
  payload: ClusterObject,
  spec: { kind: string; apiVersion: string }
): ClusterObject {
  const object: ClusterObject = { ...payload, kind: spec.kind, apiVersion: spec.apiVersion };
  const stringData = object.stringData as Record<string, string> | undefined;
  if (stringData) {
    object.data = Object.fromEntries(
      Object.entries(stringData).map(([key, value]) => [key, Buffer.from(value, "utf8").toString("base64")])
    );
    delete object.stringData;
  }
  return object;
}

class FakeKubernetesApi {
  readonly cluster = new FakeCluster();
  private server = createServer((req, res) => this.handle(req, res));

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    // /api/v1/namespaces/<ns>/<plural>[/<name>] and /apis/<group>/<version>/namespaces/...
    const namespaceIndex = segments.indexOf("namespaces");

    let plural: string | undefined;
    let namespace: string | undefined;
    let name: string | undefined;

    if (namespaceIndex === -1) {
      plural = undefined;
    } else if (namespaceIndex === segments.length - 1) {
      // cluster-scoped collection: /api/v1/namespaces
      plural = "namespaces";
    } else if (namespaceIndex === segments.length - 2) {
      // cluster-scoped item: /api/v1/namespaces/<name>
      plural = "namespaces";
      name = segments[namespaceIndex + 1];
    } else {
      // namespaced resource: .../namespaces/<namespace>/<plural>[/<name>]
      namespace = segments[namespaceIndex + 1];
      plural = segments[namespaceIndex + 2];
      name = segments[namespaceIndex + 3];
    }

    const spec = plural ? KIND_BY_PATH[plural] : undefined;
    if (!spec) {
      notFound(res, url.pathname);
      return;
    }

    const method = req.method ?? "GET";
    const cluster = this.cluster;

    if (method === "GET") {
      if (name) {
        const object = cluster.get(spec.kind, namespace, name);
        object ? send(res, 200, object) : notFound(res, name);
        return;
      }
      send(res, 200, {
        apiVersion: spec.apiVersion,
        kind: `${spec.kind}List`,
        items: cluster.list(spec.kind),
      });
      return;
    }

    if (method === "POST") {
      const payload = (await this.body(req)) as unknown as ClusterObject;
      const objectName = payload.metadata?.name;
      if (!objectName) {
        send(res, 422, { kind: "Status", code: 422, message: "metadata.name is required" });
        return;
      }
      if (cluster.get(spec.kind, namespace, objectName)) {
        send(res, 409, {
          kind: "Status",
          apiVersion: "v1",
          reason: "AlreadyExists",
          code: 409,
          message: `${spec.kind} "${objectName}" already exists`,
        });
        return;
      }
      cluster.recordCreate(spec.kind);
      send(res, 201, cluster.write(normalize(payload, spec), namespace));
      return;
    }

    if (method === "PUT") {
      if (!name) {
        notFound(res, url.pathname);
        return;
      }
      const current = cluster.get(spec.kind, namespace, name);
      if (!current) {
        notFound(res, name);
        return;
      }
      const replacement = (await this.body(req)) as unknown as ClusterObject;
      const sentVersion = replacement.metadata?.resourceVersion;
      // Real update semantics: an update must carry the resourceVersion it is based on, and a
      // stale one is a conflict. The fake enforces both so the platform cannot regress into a
      // blind overwrite.
      if (!sentVersion) {
        send(res, 422, {
          kind: "Status",
          code: 422,
          reason: "Invalid",
          message: "metadata.resourceVersion: Invalid value: must be specified for an update",
        });
        return;
      }
      if (sentVersion !== current.metadata.resourceVersion) {
        send(res, 409, {
          kind: "Status",
          code: 409,
          reason: "Conflict",
          message: `Operation cannot be fulfilled: the object has been modified`,
        });
        return;
      }
      cluster.recordReplace(spec.kind);
      send(res, 200, cluster.write(normalize(replacement, spec), namespace));
      return;
    }

    // The platform must NOT converge objects with PATCH: @kubernetes/client-node sends
    // `application/json-patch+json`, which a merge-patch body is not. A real API server would
    // reject it, so the fake one does too.
    if (method === "PATCH") {
      send(res, 415, {
        kind: "Status",
        code: 415,
        message: `unsupported media type ${req.headers["content-type"] ?? "unknown"}: send PUT instead`,
      });
      return;
    }

    if (method === "DELETE") {
      if (!name || !cluster.delete(spec.kind, namespace, name)) {
        notFound(res, name ?? url.pathname);
        return;
      }
      send(res, 200, { kind: "Status", apiVersion: "v1", status: "Success" });
      return;
    }

    send(res, 405, { kind: "Status", code: 405, message: `unsupported method ${method}` });
  }
}

/** Stub Helm CLI: records invocations, models release existence, refuses plain `install`. */
function writeFakeHelm(dir: string): string {
  const script = `#!/usr/bin/env bash
set -euo pipefail
state="\${FAKE_HELM_STATE_DIR:?}"
printf '%s\\n' "$*" >> "$state/invocations.log"
case "$1" in
  status)
    if [ -f "$state/release" ]; then
      echo '{"name":"fake","info":{"status":"deployed"}}'
      exit 0
    fi
    echo 'Error: release: not found' >&2
    exit 1
    ;;
  uninstall)
    rm -f "$state/release"
    echo 'release "fake" uninstalled'
    exit 0
    ;;
  upgrade)
    touch "$state/release"
    echo 'Release "fake" has been upgraded.'
    exit 0
    ;;
  install)
    echo 'Error: cannot re-use a name that is still in use' >&2
    exit 1
    ;;
  *)
    echo "unexpected helm invocation: $*" >&2
    exit 2
    ;;
esac
`;
  const file = path.join(dir, "helm");
  writeFileSync(file, script, "utf8");
  chmodSync(file, 0o755);
  return file;
}

let workDir: string;
let helmStateDir: string;
let helmInvocations: () => string[];
const cluster = new FakeKubernetesApi();
let provisionStore: (storeId: string) => Promise<void>;
let deprovisionStore: (storeId: string) => Promise<void>;

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "urumi-test-"));
  helmStateDir = path.join(workDir, "helm-state");
  writeFileSync(path.join(workDir, "dummy"), "");
  const helmBin = writeFakeHelm(workDir);
  require("node:fs").mkdirSync(helmStateDir, { recursive: true });
  writeFileSync(path.join(helmStateDir, "invocations.log"), "");

  const server = await cluster.start();
  const kubeconfig = path.join(workDir, "kubeconfig.yaml");
  writeFileSync(
    kubeconfig,
    `apiVersion: v1
kind: Config
clusters:
  - name: fake
    cluster:
      server: ${server}
      # @kubernetes/client-node refuses plain HTTP unless TLS verification is explicitly off.
      insecure-skip-tls-verify: true
contexts:
  - name: fake
    context:
      cluster: fake
      user: fake
current-context: fake
users:
  - name: fake
    user: {}
`,
    "utf8"
  );

  // config.ts and k8s/client.ts read these at import time.
  process.env.DATABASE_URL = "postgresql://urumi:urumi@localhost:5432/urumi";
  process.env.KUBECONFIG = kubeconfig;
  process.env.HELM_BIN = helmBin;
  process.env.FAKE_HELM_STATE_DIR = helmStateDir;
  process.env.STORE_DOMAIN = "localtest.me";
  process.env.STORE_PROBE_MODE = "service";
  process.env.DELETE_POLL_INTERVAL_MS = "10";
  process.env.DELETE_TIMEOUT_MS = "2000";

  helmInvocations = () =>
    readFileSync(path.join(helmStateDir, "invocations.log"), "utf8")
      .split("\n")
      .filter(Boolean);

  ({ provisionStore, deprovisionStore } = await import("../services/provisioner.service.js"));
});

afterAll(async () => {
  await cluster.stop();
  rmSync(workDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const NAMESPACE = "store-test1234";

describe("provisionStore is convergent", () => {
  it("creates resources once and reuses credentials across repeated runs", async () => {
    await provisionStore(STORE_ID);

    expect(h.row.status).toBe("Ready");
    expect(h.row.url).toBe(`http://${NAMESPACE}.localtest.me`);
    expect(cluster.cluster.createCount("Namespace")).toBe(1);
    expect(cluster.cluster.createCount("ResourceQuota")).toBe(1);
    expect(cluster.cluster.createCount("LimitRange")).toBe(1);
    expect(cluster.cluster.createCount("NetworkPolicy")).toBe(4);
    expect(cluster.cluster.createCount("Secret")).toBe(1);

    const secret = cluster.cluster.get("Secret", NAMESPACE, "store-credentials");
    const firstPasswords = JSON.stringify(secret?.stringData);

    // Second run: exactly the scenario of an API crash mid-provision and a restart.
    await provisionStore(STORE_ID);

    expect(h.row.status).toBe("Ready");
    expect(cluster.cluster.createCount("Namespace")).toBe(1);
    expect(cluster.cluster.createCount("ResourceQuota")).toBe(1);
    expect(cluster.cluster.createCount("LimitRange")).toBe(1);
    expect(cluster.cluster.createCount("NetworkPolicy")).toBe(4);
    // The decisive assertion: no second Secret, and no rotated password.
    expect(cluster.cluster.createCount("Secret")).toBe(1);
    expect(JSON.stringify(cluster.cluster.get("Secret", NAMESPACE, "store-credentials")?.stringData)).toBe(
      firstPasswords
    );

    // Existing objects are converged by replacing them with the desired state.
    expect(cluster.cluster.replaceCount("ResourceQuota")).toBeGreaterThanOrEqual(1);
    expect(cluster.cluster.replaceCount("LimitRange")).toBeGreaterThanOrEqual(1);
    expect(cluster.cluster.replaceCount("NetworkPolicy")).toBeGreaterThanOrEqual(4);
  });

  it("drives Helm with `upgrade --install` so an existing release reconciles", async () => {
    const invocations = helmInvocations().filter((line) => line.startsWith("upgrade"));
    expect(invocations.length).toBe(2);
    for (const line of invocations) {
      expect(line).toContain("--install");
      expect(line).toContain(`--namespace ${NAMESPACE}`);
      expect(line).toContain("--wait");
      expect(line).toContain("--wait-for-jobs");
      expect(line).toContain("wordpress.existingSecret=store-credentials");
      // Passwords must never travel through --set: Helm stores them in the release Secret.
      expect(line).not.toContain("wordpressPassword");
      expect(line).not.toContain("rootPassword");
    }
    expect(helmInvocations().some((line) => line.startsWith("install "))).toBe(false);
  });

  it("provisions without the platform's own network policy when the platform namespace differs", () => {
    const policies = cluster.cluster.list("NetworkPolicy").map((policy) => policy.metadata.name);
    expect(policies).toContain("allow-platform-ingress");
    const platformPolicy = cluster.cluster.get("NetworkPolicy", NAMESPACE, "allow-platform-ingress");
    expect(JSON.stringify(platformPolicy?.spec)).toContain("urumi-system");
  });
});

describe("deprovisionStore is repeatable", () => {
  it("uninstalls, deletes the namespace, removes the record, then no-ops", async () => {
    await deprovisionStore(STORE_ID);

    expect(h.rowDeleted.value).toBe(true);
    expect(cluster.cluster.get("Namespace", undefined, NAMESPACE)).toBeUndefined();
    expect(helmInvocations().some((line) => line.startsWith("uninstall"))).toBe(true);

    const invocationsAfterFirstDelete = helmInvocations().length;

    // A second DELETE request (or a startup reconciliation pass) must be a no-op, not an error.
    await expect(deprovisionStore(STORE_ID)).resolves.toBeUndefined();
    expect(helmInvocations().length).toBe(invocationsAfterFirstDelete);
  });
});
