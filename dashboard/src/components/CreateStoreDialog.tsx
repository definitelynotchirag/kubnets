import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useCreateStore } from "../hooks/useCreateStore";
import type { StoreEngine } from "@urumi/shared";

export function CreateStoreDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [engine, setEngine] = useState<StoreEngine>("woocommerce");
  const createStore = useCreateStore();

  const handleCreate = () => {
    createStore.mutate(
      { engine },
      {
        onSuccess: () => setIsOpen(false),
      }
    );
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white transition-all hover:bg-[var(--color-accent-hover)] active:scale-[0.98]"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
        New Store
      </button>
    );
  }

  return (
    <div className="animate-scale-in rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-5 shadow-sm w-80">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Create Store</h3>
        <button
          onClick={() => setIsOpen(false)}
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-5">
        <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-2 tracking-wide uppercase">
          Engine
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setEngine("woocommerce")}
            className={`px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
              engine === "woocommerce"
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)]"
            }`}
          >
            WooCommerce
          </button>
          <button
            onClick={() => setEngine("medusa")}
            className={`px-3 py-2.5 rounded-lg border text-sm font-medium transition-all relative ${
              engine === "medusa"
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)]"
            }`}
          >
            MedusaJS
            <span className="absolute -top-1.5 -right-1.5 text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">
              Beta
            </span>
          </button>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleCreate}
          disabled={createStore.isPending}
          className="flex-1 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-white transition-all hover:bg-[var(--color-accent-hover)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {createStore.isPending ? (
            <span className="inline-flex items-center gap-2">
              <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Creating...
            </span>
          ) : (
            "Create"
          )}
        </button>
        <button
          onClick={() => setIsOpen(false)}
          className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-text-secondary)] transition-all hover:bg-stone-50 active:scale-[0.98]"
        >
          Cancel
        </button>
      </div>

      {createStore.isError && (
        <p className="mt-3 text-xs text-[var(--color-status-failed)] bg-[var(--color-status-failed-bg)] rounded-lg px-3 py-2">
          {createStore.error.message}
        </p>
      )}
    </div>
  );
}
