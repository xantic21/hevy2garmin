"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { withBasePath } from "@/lib/base-path";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: "◉" },
  { href: "/workouts", label: "Workouts", icon: "≡" },
  { href: "/routines", label: "Routines", icon: "◱" },
  { href: "/mappings", label: "Mappings", icon: "⇄" },
  { href: "/history", label: "History", icon: "◷" },
  { href: "/settings", label: "Settings", icon: "⚙" },
  { href: "/setup", label: "Setup", icon: "⇆" },
];

export function NavBar({ authEnabled = false, strictMode = true }: { authEnabled?: boolean; strictMode?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  // Hide the whole bar on the login screen.
  if (pathname === "/login") return null;

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch(withBasePath("/api/logout"), { method: "POST" });
    } catch {
      // ignore — navigate to login regardless
    }
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      {/* Desktop: top bar (One UI: quiet white bar, pill for the current page) */}
      <nav
        aria-label="Main"
        className="hidden md:flex items-center justify-between gap-4 px-6 py-3 bg-surface/90 backdrop-blur border-b border-border-subtle sticky top-0 z-40"
      >
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight text-text">
            hevy2garmin
          </Link>
          {strictMode && (
            <span
              className="oui-pill bg-teal-bg text-teal"
              title="Sets are merged into the watch's own activity, verified by read-back. No uploads, no deletions."
            >
              <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-teal" />
              Strict in-place
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {NAV_ITEMS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(href) ? "page" : undefined}
              className={`rounded-full px-4 py-2 text-sm transition-colors ${
                isActive(href)
                  ? "bg-teal-bg text-teal font-semibold"
                  : "text-text-secondary hover:text-text hover:bg-surface-hover"
              }`}
            >
              {label}
            </Link>
          ))}
          {authEnabled && (
            <button
              type="button"
              onClick={logout}
              disabled={loggingOut}
              className="ml-2 rounded-full border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              {loggingOut ? "Logging out…" : "Log out"}
            </button>
          )}
        </div>
      </nav>

      {/* Mobile: bottom tab bar within thumb reach (One UI), active item on a tonal pill */}
      <nav
        aria-label="Main"
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex items-stretch justify-around bg-surface/95 backdrop-blur border-t border-border-subtle px-1 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        {NAV_ITEMS.map(({ href, label, icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={isActive(href) ? "page" : undefined}
            className={`flex min-w-[44px] flex-1 flex-col items-center gap-0.5 py-1 ${
              isActive(href) ? "text-teal" : "text-text-muted"
            }`}
          >
            <span
              aria-hidden="true"
              className={`flex h-7 w-11 items-center justify-center rounded-full text-base ${isActive(href) ? "bg-teal-bg" : ""}`}
            >
              {icon}
            </span>
            <span className={`text-[10px] ${isActive(href) ? "font-semibold" : "font-medium"}`}>{label}</span>
          </Link>
        ))}
        {authEnabled && (
          <button
            type="button"
            onClick={logout}
            disabled={loggingOut}
            className="flex min-w-[44px] flex-1 flex-col items-center gap-0.5 py-1 text-text-muted disabled:opacity-50"
          >
            <span aria-hidden="true" className="flex h-7 w-11 items-center justify-center text-base">⏻</span>
            <span className="text-[10px] font-medium">Log out</span>
          </button>
        )}
      </nav>
    </>
  );
}
