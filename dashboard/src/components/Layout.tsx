import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { data: metrics } = useQuery({
    queryKey: ["metrics"],
    queryFn: api.getMetrics,
    refetchInterval: 10000,
  });

  const isHome = location.pathname === "/";

  return (
    <div className="min-h-screen bg-[var(--color-surface)]">
      {/* Header */}
      <header className="border-b border-[var(--color-border)]">
        <div className="max-w-5xl mx-auto px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <Link
              to="/"
              className="text-[var(--color-text-primary)] tracking-tight font-semibold text-lg transition-opacity hover:opacity-70"
            >
              urumi
            </Link>

            {/* Minimal stats in header */}
            {metrics && (
              <div className="flex items-center gap-5 text-xs text-[var(--color-text-muted)] animate-fade-in">
                <span>
                  <span className="text-[var(--color-text-secondary)] font-medium">{metrics.totalStores}</span> stores
                </span>
                {(metrics.byStatus["Ready"] ?? 0) > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    <span className="text-[var(--color-text-secondary)] font-medium">{metrics.byStatus["Ready"]}</span> live
                  </span>
                )}
                {(metrics.byStatus["Provisioning"] ?? 0) > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
                    <span className="text-[var(--color-text-secondary)] font-medium">{metrics.byStatus["Provisioning"]}</span> deploying
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-6 lg:px-8 py-10">
        <div className={isHome ? "animate-fade-in" : "animate-fade-in-up"}>
          {children}
        </div>
      </main>
    </div>
  );
}
