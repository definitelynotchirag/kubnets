import { useParams, Link } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, Clock, AlertCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "../hooks/useStores";
import { StatusBadge } from "./StatusBadge";
import { api } from "../api/client";
import type { StoreStatus } from "@urumi/shared";

function DetailRow({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between py-3 border-b border-[var(--color-border-subtle)] last:border-b-0">
      <dt className="text-xs font-medium text-[var(--color-text-muted)] tracking-wide uppercase">
        {label}
      </dt>
      <dd className={`text-sm text-[var(--color-text-primary)] ${mono ? "font-mono text-xs" : ""}`}>
        {children}
      </dd>
    </div>
  );
}

export function StoreDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useStore(id!);
  const { data: logsData } = useQuery({
    queryKey: ["store-logs", id],
    queryFn: () => api.getStoreLogs(id!),
    refetchInterval: 5000,
  });

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

  const store = data?.store;
  if (!store) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-[var(--color-text-muted)]">Store not found</p>
      </div>
    );
  }

  const logs = logsData?.logs ?? [];

  return (
    <div>
      {/* Back */}
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors mb-6"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All stores
      </Link>

      {/* Header */}
      <div className="flex items-center justify-between mb-6 animate-fade-in">
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)] tracking-tight">
            {store.namespace}
          </h1>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5 uppercase tracking-wide">
            {store.engine}
          </p>
        </div>
        <StatusBadge status={store.status as StoreStatus} />
      </div>

      {/* Error banner */}
      {store.errorMessage && (
        <div className="animate-fade-in mb-6 rounded-xl border border-red-200 bg-[var(--color-status-failed-bg)] p-4 flex gap-3">
          <AlertCircle className="h-4 w-4 text-[var(--color-status-failed)] shrink-0 mt-0.5" />
          <pre className="text-xs text-[var(--color-status-failed)] font-mono whitespace-pre-wrap leading-relaxed">
            {store.errorMessage}
          </pre>
        </div>
      )}

      {/* Details card */}
      <div className="animate-fade-in-up stagger-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-5 py-2">
        <DetailRow label="ID" mono>
          {store.id}
        </DetailRow>

        <DetailRow label="URL">
          {store.url ? (
            <a
              href={store.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[var(--color-text-primary)] hover:text-[var(--color-accent-hover)] transition-colors"
            >
              {store.url.replace(/^https?:\/\//, "")}
              <ArrowUpRight className="h-3 w-3" />
            </a>
          ) : (
            <span className="text-[var(--color-text-muted)]">&mdash;</span>
          )}
        </DetailRow>

        <DetailRow label="Created">
          {new Date(store.createdAt).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </DetailRow>

        <DetailRow label="Updated">
          {new Date(store.updatedAt).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </DetailRow>
      </div>

      {/* Activity Log */}
      <div className="animate-fade-in-up stagger-3 mt-8">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)] mb-4 tracking-tight">
          Activity
        </h2>

        {logs.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)] py-8 text-center">
            No activity recorded yet.
          </p>
        ) : (
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-[var(--color-border)]" />

            <div className="space-y-0">
              {logs.map((log, i) => (
                <div
                  key={log.id}
                  className={`animate-fade-in stagger-${Math.min(i + 1, 8)} relative flex items-start gap-4 py-3`}
                >
                  {/* Dot */}
                  <div className="relative z-10 mt-1">
                    <div className="w-[15px] h-[15px] rounded-full border-2 border-[var(--color-border)] bg-[var(--color-surface-raised)]" />
                  </div>

                  {/* Content */}
                  <div className="flex-1 flex items-baseline justify-between min-w-0">
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-[var(--color-text-primary)]">
                        {log.action.replace("store.", "")}
                      </span>
                      {log.details && (
                        <p className="text-xs text-[var(--color-text-muted)] mt-0.5 truncate">
                          {log.details}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)] whitespace-nowrap ml-4 shrink-0">
                      <Clock className="h-3 w-3" />
                      {new Date(log.createdAt).toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
