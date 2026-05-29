"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { X, Menu } from "lucide-react";

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  disabled?: boolean;
}

interface SettingsSidebarProps {
  items: NavItem[];
  open: boolean;
  onClose: () => void;
}

export function SettingsSidebar({ items, open, onClose }: SettingsSidebarProps) {
  const pathname = usePathname();

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-40 sm:hidden"
          onClick={onClose}
        />
      )}
      <nav
        className={`
          shrink-0 border-r border-border bg-surface
          sm:relative sm:block
          ${open ? "fixed inset-y-0 left-0 z-50 sm:relative" : "hidden sm:block"}
        `}
        style={{ width: "224px", minWidth: "224px" }}
      >
        <div className="flex items-center justify-between p-4 border-b border-border sm:hidden">
          <h2 className="text-sm font-semibold text-foreground">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-foreground/5"
            aria-label="Close menu"
          >
            <X className="size-5 text-muted" />
          </button>
        </div>

        <div className="py-4">
          <div className="px-4 mb-2 hidden sm:block">
            <h2 className="text-[11px] font-semibold text-muted uppercase tracking-wider">
              Settings
            </h2>
          </div>
          <div className="space-y-0.5 px-2">
            {items.map((item) => {
              const isActive = pathname === item.href;
              if (item.disabled) {
                return (
                  <div
                    key={item.href}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted/40 cursor-not-allowed"
                    title="Coming soon"
                  >
                    <span className="text-muted/40">{item.icon}</span>
                    {item.label}
                  </div>
                );
              }
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                    isActive
                      ? "bg-foreground/5 text-foreground font-medium"
                      : "text-muted hover:bg-foreground/[0.03] hover:text-foreground"
                  }`}
                >
                  <span className="text-muted">{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      </nav>
    </>
  );
}

interface SettingsPageLayoutProps {
  children: React.ReactNode;
  navItems: NavItem[];
}

export function SettingsPageLayout({ children, navItems }: SettingsPageLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex flex-1 h-screen">
      <SettingsSidebar
        items={navItems}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="flex-1 overflow-auto">
        <div className="flex items-center gap-4 p-4 border-b border-border sm:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-lg hover:bg-foreground/5"
            aria-label="Open menu"
          >
            <Menu className="size-5 text-muted" />
          </button>
          <span className="text-sm font-semibold text-foreground">Settings</span>
        </div>

        <div style={{ padding: "32px 24px" }}>
          {children}
        </div>
      </main>
    </div>
  );
}