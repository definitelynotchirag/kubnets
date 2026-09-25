import type { StoreStatus } from "@urumi/shared";

const statusConfig: Record<StoreStatus, { bg: string; text: string; dot: string; pulse?: boolean }> = {
  Ready: {
    bg: "bg-[var(--color-status-ready-bg)]",
    text: "text-[var(--color-status-ready)]",
    dot: "bg-emerald-500",
  },
  Provisioning: {
    bg: "bg-[var(--color-status-provisioning-bg)]",
    text: "text-[var(--color-status-provisioning)]",
    dot: "bg-amber-400",
    pulse: true,
  },
  Pending: {
    bg: "bg-[var(--color-status-pending-bg)]",
    text: "text-[var(--color-status-pending)]",
    dot: "bg-blue-400",
    pulse: true,
  },
  Failed: {
    bg: "bg-[var(--color-status-failed-bg)]",
    text: "text-[var(--color-status-failed)]",
    dot: "bg-red-500",
  },
  Deleting: {
    bg: "bg-[var(--color-status-deleting-bg)]",
    text: "text-[var(--color-status-deleting)]",
    dot: "bg-stone-400",
    pulse: true,
  },
};

export function StatusBadge({ status }: { status: StoreStatus }) {
  const config = statusConfig[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium tracking-wide ${config.bg} ${config.text}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${config.dot} ${config.pulse ? "animate-pulse-dot" : ""}`}
      />
      {status}
    </span>
  );
}
