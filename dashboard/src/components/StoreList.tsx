import { Link } from "react-router-dom";
import { Trash2, ArrowUpRight, Box } from "lucide-react";
import { useStores } from "../hooks/useStores";
import { useDeleteStore } from "../hooks/useDeleteStore";
import { StatusBadge } from "./StatusBadge";
import { CreateStoreDialog } from "./CreateStoreDialog";
import type { StoreStatus } from "@urumi/shared";

export function StoreList() {
  const { data, isLoading, error } = useStores();
  const deleteStore = useDeleteStore();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-5 h-5 border-2 border-stone-200 border-t-stone-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-[var(--color-status-failed)]">{error.message}</p>
      </div>
    );
  }

  const stores = data?.stores ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)] tracking-tight">
            Stores
          </h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-0.5">
            {stores.length === 0
              ? "No stores provisioned yet"
              : `${stores.length} store${stores.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <CreateStoreDialog />
      </div>

      {stores.length === 0 ? (
        <div className="animate-fade-in-up flex flex-col items-center justify-center py-20 rounded-xl border border-dashed border-[var(--color-border)]">
          <div className="w-10 h-10 rounded-full bg-stone-100 flex items-center justify-center mb-4">
            <Box className="w-5 h-5 text-[var(--color-text-muted)]" />
          </div>
          <p className="text-sm text-[var(--color-text-secondary)] font-medium">No stores yet</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">Create one to get started</p>
        </div>
      ) : (
        <div className="space-y-2">
          {stores.map((store, i) => (
            <div
              key={store.id}
              className={`animate-fade-in-up stagger-${Math.min(i + 1, 8)} group rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] transition-all hover:shadow-sm hover:border-stone-300`}
            >
              <div className="flex items-center justify-between px-5 py-4">
                {/* Left: namespace + engine */}
                <div className="flex items-center gap-4 min-w-0">
                  <Link
                    to={`/stores/${store.id}`}
                    className="text-sm font-medium text-[var(--color-text-primary)] hover:text-[var(--color-accent-hover)] transition-colors truncate"
                  >
                    {store.namespace}
                  </Link>
                  <span className="text-[11px] text-[var(--color-text-muted)] font-medium tracking-wide uppercase shrink-0">
                    {store.engine}
                  </span>
                </div>

                {/* Center: status */}
                <div className="flex items-center gap-4">
                  <StatusBadge status={store.status as StoreStatus} />
                </div>

                {/* Right: url + actions */}
                <div className="flex items-center gap-3">
                  {store.url ? (
                    <a
                      href={store.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
                    >
                      <span className="max-w-[180px] truncate">{store.url.replace(/^https?:\/\//, "")}</span>
                      <ArrowUpRight className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {new Date(store.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  )}

                  <button
                    onClick={() => {
                      if (confirm(`Delete store ${store.namespace}?`)) {
                        deleteStore.mutate(store.id);
                      }
                    }}
                    disabled={store.status === "Deleting"}
                    className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] transition-all disabled:opacity-30 p-1 rounded-md hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
