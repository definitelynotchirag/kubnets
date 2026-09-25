export type StoreStatus =
  | "Pending"
  | "Provisioning"
  | "Ready"
  | "Failed"
  | "Deleting";

export type StoreEngine = "woocommerce" | "medusa";

export interface Store {
  id: string;
  namespace: string;
  engine: StoreEngine;
  status: StoreStatus;
  url: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStoreRequest {
  engine: StoreEngine;
}

export interface CreateStoreResponse {
  store: Store;
}

export interface ListStoresResponse {
  stores: Store[];
}

export interface GetStoreResponse {
  store: Store;
}

export interface DeleteStoreResponse {
  message: string;
}

export interface ErrorResponse {
  error: string;
  details?: unknown;
}
