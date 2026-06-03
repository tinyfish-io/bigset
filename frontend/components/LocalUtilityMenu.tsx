"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Settings, SlidersHorizontal } from "lucide-react";
import { useTheme } from "@/components/ThemeToggle";

export function LocalUtilityMenu({
  showSettingsLink = true,
}: {
  showSettingsLink?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { theme, toggle: toggleTheme } = useTheme();

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((next) => !next)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="local-utility-menu"
        aria-label="Open local menu"
        title="Local menu"
        className="inline-flex size-8 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
      >
        <SlidersHorizontal className="size-4" />
      </button>

      {open && (
        <div
          id="local-utility-menu"
          role="menu"
          className="absolute right-0 top-full z-50 mt-1.5 w-48 overflow-hidden rounded-xl border border-border bg-surface shadow-xl ring-1 ring-black/[0.04]"
        >
          <div className="p-1">
            <button
              type="button"
              onClick={toggleTheme}
              className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-foreground/[0.05]"
            >
              <span>Dark mode</span>
              <span
                className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                  theme === "dark" ? "bg-foreground" : "bg-foreground/20"
                }`}
              >
                <span
                  className={`inline-block h-3 w-3 rounded-full bg-surface transition-transform ${
                    theme === "dark" ? "translate-x-3.5" : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>

            {showSettingsLink && (
              <Link
                href="/dashboard/settings/models"
                onClick={() => setOpen(false)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-foreground/[0.05]"
              >
                <Settings className="size-3.5" />
                Settings
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
