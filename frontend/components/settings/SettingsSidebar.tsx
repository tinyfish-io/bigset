"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  disabled?: boolean;
}

interface SettingsSidebarProps {
  items: NavItem[];
}

export function SettingsSidebar({ items }: SettingsSidebarProps) {
  const pathname = usePathname();

  return (
    <nav
      className="shrink-0 border-r border-border bg-surface/50"
      style={{ width: "224px", minWidth: "224px" }}
    >
      <div className="py-4">
        <div className="px-4 mb-2">
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
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? "bg-foreground/5 text-foreground font-medium"
                    : "text-muted hover:bg-foreground/3 hover:text-foreground"
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
  );
}