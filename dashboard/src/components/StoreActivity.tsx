import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Boxes,
  Check,
  Clock,
  Eraser,
  Globe,
  KeyRound,
  Loader2,
  Package,
  PackageX,
  Rocket,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { AuditLog } from "../api/client";
import type { Store, StoreStatus } from "@urumi/shared";

/**
 * Live activity view for a store.
 *
 * Provisioning takes minutes, so the interesting information is *which step is running now*.
 * Two pieces do that work: a pipeline stepper derived from the audit trail (so it advances as the
 * API records each step) and a timeline that highlights events as they arrive rather than
 * re-rendering the same list every poll.
 */

const TRANSIENT_STATUSES: StoreStatus[] = ["Pending", "Provisioning", "Deleting"];

const ACTION_META: Record<string, { label: string; Icon: typeof Check }> = {
  "store.created": { label: "Store requested", Icon: Sparkles },
  "store.provisioning": { label: "Provisioning started", Icon: Rocket },
  "store.namespace_ready": { label: "Isolation boundary ready", Icon: ShieldCheck },
  "store.credentials_ready": { label: "Credentials ready", Icon: KeyRound },
  "store.helm_started": { label: "Deploying WordPress, MariaDB and WooCommerce", Icon: Package },
  "store.helm_ready": { label: "Workloads and initialization finished", Icon: Boxes },
  "store.verifying": { label: "Verifying the storefront", Icon: Globe },
  "store.ready": { label: "Store is live", Icon: BadgeCheck },
  "store.failed": { label: "Provisioning failed", Icon: AlertTriangle },
  "store.delete_requested": { label: "Deletion requested", Icon: Trash2 },
  "store.helm_uninstalled": { label: "Helm release removed", Icon: PackageX },
  "store.namespace_deleted": { label: "Namespace and resources removed", Icon: Eraser },
  "store.deleted": { label: "Store deleted", Icon: Check },
};

/** The provisioning pipeline, in order. Each stage completes when one of its actions is logged. */
const PIPELINE: Array<{ label: string; done: string[]; active: string[] }> = [
  { label: "Store requested", done: ["store.created"], active: [] },
  { label: "Isolation boundary", done: ["store.namespace_ready"], active: [] },
  { label: "Per-store credentials", done: ["store.credentials_ready"], active: [] },
  {
    label: "Workloads + WooCommerce init",
    done: ["store.helm_ready"],
    active: ["store.helm_started"],
  },
  { label: "Storefront verified", done: ["store.ready"], active: ["store.verifying"] },
];

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function formatRelative(iso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

export function StoreActivity({ store, logs }: { store: Store; logs: AuditLog[] }) {
  const transient = TRANSIENT_STATUSES.includes(store.status);
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  // Tick once a second while something is happening so elapsed/relative times stay honest;
  // stop entirely once the store settles (no needless renders on a finished store).
  useEffect(() => {
    if (!transient) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [transient]);

  // Animate only events that arrive after the first render, so a normal page load does not
  // replay the whole history and repeated polls do not re-trigger animations.
  useEffect(() => {
    const newcomers = logs.filter((log) => !seen.current.has(log.id));
    if (newcomers.length === 0) return;
    const isFirstLoad = seen.current.size === 0;
    newcomers.forEach((log) => seen.current.add(log.id));
    setFresh(isFirstLoad ? new Set() : new Set(newcomers.map((log) => log.id)));
  }, [logs]);

  const actions = new Set(logs.map((log) => log.action));
  const activeIndex = PIPELINE.findIndex(
    (stage) => !stage.done.some((action) => actions.has(action))
  );
  const showPipeline = store.status === "Pending" || store.status === "Provisioning";

  return (
    <div className="animate-fade-in-up stagger-3 mt-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)] tracking-tight">
          Activity
        </h2>
        {transient && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-status-provisioning-bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-status-provisioning)]">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping-slow absolute inline-flex h-full w-full rounded-full bg-current opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
            </span>
            {store.status === "Provisioning" ? "provisioning" : store.status.toLowerCase()} ·{" "}
            {formatElapsed(now - new Date(store.createdAt).getTime())}
          </span>
        )}
      </div>

      {showPipeline && (
        <div className="animate-scale-in mb-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4">
          <div className="mb-3 h-1 w-full overflow-hidden rounded-full bg-[var(--color-border-subtle)]">
            {/* Indeterminate: the API reports steps, not percentages, so the bar shows motion
                rather than pretending to know how far along Helm is. */}
            <div className="animate-progress h-full w-1/3 rounded-full bg-[var(--color-accent)]" />
          </div>
          <ol className="space-y-2.5">
            {PIPELINE.map((stage, index) => {
              const done = stage.done.some((action) => actions.has(action));
              const running = !done && stage.active.some((action) => actions.has(action)) ||
                (!done && index === activeIndex);
              return (
                <li
                  key={stage.label}
                  className={`flex items-center gap-2.5 text-xs transition-opacity ${
                    done || running ? "opacity-100" : "opacity-40"
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      done
                        ? "animate-pop-in border-[var(--color-status-ready)] bg-[var(--color-status-ready)] text-white"
                        : running
                          ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                          : "border-[var(--color-border)]"
                    }`}
                  >
                    {done ? (
                      <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    ) : running ? (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    ) : null}
                  </span>
                  <span
                    className={
                      done
                        ? "text-[var(--color-text-secondary)]"
                        : running
                          ? "font-medium text-[var(--color-text-primary)]"
                          : "text-[var(--color-text-muted)]"
                    }
                  >
                    {stage.label}
                  </span>
                  {running && (
                    <span className="ml-auto text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                      in progress
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {logs.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)] py-8 text-center">
          No activity recorded yet.
        </p>
      ) : (
        <div className="relative">
          <div className="absolute left-[7px] top-2 bottom-2 w-px bg-[var(--color-border)]" />
          <div>
            {logs.map((log) => {
              const meta = ACTION_META[log.action] ?? { label: log.action.replace("store.", ""), Icon: Clock };
              const { Icon } = meta;
              const isFresh = fresh.has(log.id);
              const isFailure = log.action === "store.failed";
              return (
                <div
                  key={log.id}
                  className={`relative flex items-start gap-4 py-3 ${
                    isFresh ? "animate-slide-in-left" : "animate-fade-in"
                  }`}
                >
                  <div className="relative z-10 mt-0.5">
                    <div
                      className={`flex h-[15px] w-[15px] items-center justify-center rounded-full border-2 bg-[var(--color-surface-raised)] ${
                        isFailure
                          ? "border-[var(--color-status-failed)] text-[var(--color-status-failed)]"
                          : "border-[var(--color-border)] text-[var(--color-text-secondary)]"
                      }`}
                    >
                      <Icon className="h-2 w-2" strokeWidth={2.5} />
                    </div>
                  </div>

                  <div className="flex min-w-0 flex-1 items-baseline justify-between gap-4">
                    <div className="min-w-0">
                      <span
                        className={`text-sm ${
                          isFailure
                            ? "font-medium text-[var(--color-status-failed)]"
                            : "font-medium text-[var(--color-text-primary)]"
                        }`}
                      >
                        {meta.label}
                      </span>
                      {log.details && (
                        <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">
                          {log.details}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 whitespace-nowrap text-[11px] text-[var(--color-text-muted)]">
                      {formatRelative(log.createdAt, now)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
