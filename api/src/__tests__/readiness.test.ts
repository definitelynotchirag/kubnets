import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * The readiness probe is what stops the platform from calling a store `Ready` just because
 * Helm finished. Its target selection is asserted directly and its retry behavior is verified
 * against a real HTTP server, so the deadline, the retry loop, the Host header and the
 * "status < 400" rule are all observable.
 */
let responsesRemaining = 0;
const seenHostHeaders: Array<string | undefined> = [];

const server = createServer((req, res) => {
  seenHostHeaders.push(req.headers.host);
  if (responsesRemaining > 0) {
    responsesRemaining -= 1;
    res.writeHead(503).end("not ready yet");
    return;
  }
  res.writeHead(200).end("<html>store</html>");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// config.ts parses the environment at import time, so both modes are imported explicitly.
process.env.DATABASE_URL = "postgresql://urumi:urumi@localhost:5432/urumi";
process.env.STORE_DOMAIN = "localtest.me";
process.env.STORE_PROBE_MODE = "service";

const { storeProbeTarget } = await import("../k8s/readiness.js");

vi.resetModules();
process.env.STORE_PROBE_MODE = "ingress";
// In ingress mode the probe dials this address and sends the store hostname as Host, which is
// exactly what the docker-compose environment does (API outside the cluster).
process.env.STORE_PROBE_INGRESS_HOST = `127.0.0.1:${port}`;

const { waitForStoreHttp } = await import("../k8s/readiness.js");

describe("probe target selection", () => {
  it("targets the store's in-cluster Service with the public hostname as Host", () => {
    process.env.STORE_PROBE_MODE = "service";
    const target = storeProbeTarget({
      namespace: "store-abc123",
      releaseName: "store-abc123",
      hostname: "store-abc123.localtest.me",
    });

    expect(target.url).toBe("http://store-abc123-wordpress.store-abc123.svc.cluster.local/");
    expect(target.hostHeader).toBe("store-abc123.localtest.me");
  });
});

describe("waitForStoreHttp", () => {
  it("retries until the storefront answers and sends the store hostname as Host", async () => {
    responsesRemaining = 2;
    seenHostHeaders.length = 0;

    await waitForStoreHttp({
      namespace: "store-abc123",
      releaseName: "store-abc123",
      hostname: "store-abc123.localtest.me",
      timeoutMs: 5_000,
      intervalMs: 10,
    });

    // Two 503s then a 200: the loop retried and then accepted the response.
    expect(seenHostHeaders.length).toBe(3);
    expect(seenHostHeaders.every((host) => host === "store-abc123.localtest.me")).toBe(true);
  });

  it("fails with the last observed status when the deadline passes", async () => {
    responsesRemaining = 100;
    seenHostHeaders.length = 0;

    await expect(
      waitForStoreHttp({
        namespace: "store-abc123",
        releaseName: "store-abc123",
        hostname: "store-abc123.localtest.me",
        timeoutMs: 120,
        intervalMs: 20,
      })
    ).rejects.toThrow(/HTTP 503/);

    expect(seenHostHeaders.length).toBeGreaterThan(0);
  });
});
