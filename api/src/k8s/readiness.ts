import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

export interface HttpProbeOptions {
  namespace: string;
  releaseName: string;
  hostname: string;
  timeoutMs: number;
  intervalMs: number;
}

/**
 * Two ways to reach a storefront, both sending the public hostname as the Host header:
 *
 * - `service`: dial the in-cluster Service `<release>-wordpress.<ns>.svc.cluster.local`.
 *   Independent of public DNS, TLS and the ingress; needs the `allow-platform-ingress` policy.
 *   Used when the platform itself runs in Kubernetes.
 * - `ingress`: dial the ingress front door (`STORE_PROBE_INGRESS_HOST`). Used when the API runs
 *   outside the cluster, e.g. the docker-compose development environment.
 */
export function storeProbeTarget(options: {
  namespace: string;
  releaseName: string;
  hostname: string;
}): { url: string; hostHeader: string } {
  if (config.STORE_PROBE_MODE === "ingress") {
    const host = config.STORE_PROBE_INGRESS_HOST || options.hostname;
    return { url: `http://${host}/`, hostHeader: options.hostname };
  }

  return {
    url: `http://${options.releaseName}-wordpress.${options.namespace}.svc.cluster.local/`,
    hostHeader: options.hostname,
  };
}

/**
 * Plain HTTP on purpose (not `fetch`):
 *   * `fetch` treats Host as a forbidden header and drops it, and
 *   * it follows redirects, which for a WordPress store would chase the public hostname from
 *     inside the cluster.
 * We want a single request, a real Host header, and "any non-error status counts": a 200 or a
 * 301 both prove the web tier is serving.
 *
 * `events.once` is used instead of a Promise executor (and instead of `Promise.withResolvers`,
 * which needs Node 22 while this image ships Node 20). It also rejects automatically when the
 * request emits `error`, including the timeout `destroy` below.
 */
async function probeOnce(url: URL, hostHeader: string): Promise<number> {
  const req = request({
    hostname: url.hostname,
    port: url.port || 80,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: { Host: hostHeader, "User-Agent": "urumi-readiness-probe" },
  });

  req.setTimeout(5_000, () => req.destroy(new Error("probe request timed out")));
  req.end();

  const [res] = (await once(req, "response")) as [IncomingMessage];
  res.resume();
  return res.statusCode ?? 0;
}

export async function waitForStoreHttp(options: HttpProbeOptions): Promise<void> {
  const target = storeProbeTarget(options);
  const deadline = Date.now() + options.timeoutMs;
  let attempt = 0;
  let lastOutcome = "no attempt made";

  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const status = await probeOnce(new URL(target.url), target.hostHeader);
      if (status < 400) {
        logger.info(
          { url: target.url, status, attempts: attempt },
          "store_http_probe_succeeded"
        );
        return;
      }
      lastOutcome = `HTTP ${status}`;
    } catch (err) {
      lastOutcome = err instanceof Error ? err.message : String(err);
    }

    logger.info({ url: target.url, attempt, outcome: lastOutcome }, "store_http_probe_attempt");
    await sleep(options.intervalMs);
  }

  throw new Error(
    `storefront did not become reachable within ${Math.round(options.timeoutMs / 1000)}s ` +
      `(${target.url}, last result: ${lastOutcome})`
  );
}
