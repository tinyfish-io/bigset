"use client";

import Link from "next/link";
import { useUser, useClerk } from "@clerk/nextjs";
import { useTheme } from "@/components/ThemeToggle";
import { useEffect, useRef, useState } from "react";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const { theme, toggle: toggleTheme } = useTheme();

  useEffect(() => {
    if (!profileOpen) return;
    function handleClick(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node))
        setProfileOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [profileOpen]);

  const name = user?.fullName || user?.firstName || "User";
  const email = user?.primaryEmailAddress?.emailAddress;
  const imageUrl = user?.imageUrl;

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between bg-surface shrink-0">
        <Link href="/dashboard" className="flex items-center gap-2">
          <img src="/BigSetLogo.png" alt="BigSet" className="h-6.5 dark:hidden" />
          <img src="/BigSetLogoDarkBG.png" alt="BigSet" className="h-6.5 hidden dark:block" />
        </Link>

        <div className="flex items-center gap-4">
          <Link
            href="/dashboard"
            className="text-xs text-muted hover:text-foreground transition-colors"
          >
            ← Back to Dashboard
          </Link>
          <div className="w-px h-4 bg-border" />
          <div ref={profileRef} className="relative">
            <button
              type="button"
              onClick={() => setProfileOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 hover:bg-foreground/5 transition-colors"
            >
              {imageUrl ? (
                <img src={imageUrl} alt="" className="h-6 w-6 rounded-full object-cover" />
              ) : (
                <div className="h-6 w-6 rounded-full bg-foreground/10 flex items-center justify-center text-[11px] font-medium text-foreground">
                  {name[0]?.toUpperCase()}
                </div>
              )}
              <span className="text-xs font-medium text-foreground">{name}</span>
            </button>

            {profileOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-52 rounded-xl border border-border bg-surface shadow-xl ring-1 ring-black/4 z-50 overflow-hidden">
                <div className="px-3 py-2 border-b border-border">
                  <p className="text-xs font-medium text-foreground truncate">{name}</p>
                  {email && (
                    <p data-ph-mask-text="true" className="text-[11px] text-muted truncate mt-0.5">
                      {email}
                    </p>
                  )}
                </div>
                <div className="p-1">
                  <button
                    onClick={toggleTheme}
                    className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs text-foreground hover:bg-foreground/5 transition-colors"
                  >
                    <span>Dark mode</span>
                    <span className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${theme === "dark" ? "bg-foreground" : "bg-foreground/20"}`}>
                      <span className={`inline-block h-3 w-3 rounded-full bg-surface transition-transform ${theme === "dark" ? "translate-x-3.5" : "translate-x-0.5"}`} />
                    </span>
                  </button>
                  <button
                    onClick={() => { setProfileOpen(false); signOut(); }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-red-500 hover:bg-red-500/8 transition-colors"
                  >
                    Sign out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}