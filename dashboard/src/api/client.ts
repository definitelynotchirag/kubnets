import type {
  CreateStoreRequest,
  CreateStoreResponse,
  ListStoresResponse,
  GetStoreResponse,
  DeleteStoreResponse,
} from "@urumi/shared";

const BASE_URL = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

export const api = {
  listStores: () => request<ListStoresResponse>("/stores"),

  getStore: (id: string) => request<GetStoreResponse>(`/stores/${id}`),

  createStore: (data: CreateStoreRequest) =>
    request<CreateStoreResponse>("/stores", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  deleteStore: (id: string) =>
    request<DeleteStoreResponse>(`/stores/${id}`, { method: "DELETE" }),

  getStoreLogs: (id: string) =>
    request<{ logs: AuditLog[] }>(`/stores/${id}/logs`),

  getAuditLogs: () =>
    request<{ logs: AuditLog[] }>("/audit-logs"),

  getMetrics: () =>
    request<StoreMetrics>("/metrics"),
};

export interface AuditLog {
  id: string;
  storeId: string | null;
  action: string;
  details: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface StoreMetrics {
  totalStores: number;
  byStatus: Record<string, number>;
  provisioningDurationAvgMs: number;
  recentFailures: number;
}
