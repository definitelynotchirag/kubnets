import { ApiException } from "@kubernetes/client-node";

/**
 * The Kubernetes API answers 404 (missing) and 409 (already exists) constantly during
 * convergent "ensure" operations. Those two are expected outcomes rather than failures,
 * so every ensure helper classifies errors through here instead of guessing.
 */
export function statusCodeOf(err: unknown): number | undefined {
  // ApiException covers @kubernetes/client-node v1; the fallbacks cover older/wrapped shapes.
  if (err instanceof ApiException) return err.code;
  const maybe = err as { code?: number; statusCode?: number; response?: { statusCode?: number } };
  return maybe?.code ?? maybe?.statusCode ?? maybe?.response?.statusCode;
}

export function isNotFound(err: unknown): boolean {
  return statusCodeOf(err) === 404;
}

export function isAlreadyExists(err: unknown): boolean {
  return statusCodeOf(err) === 409;
}
