import * as k8s from "@kubernetes/client-node";
import { config } from "../config.js";

const kc = new k8s.KubeConfig();

if (config.KUBECONFIG) {
  kc.loadFromFile(config.KUBECONFIG);
} else {
  kc.loadFromDefault();
}

export const coreApi = kc.makeApiClient(k8s.CoreV1Api);
export const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
export { kc };
