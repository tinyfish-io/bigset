"use client";

import { ChevronRight } from "lucide-react";

interface SettingsTileProps {
  label: string;
  description?: string;
  value?: string;
  onClick: () => void;
  showTrailingButton?: boolean;
  trailingIcon?: React.ReactNode;
}

export function SettingsTile({
  label,
  description,
  value,
  onClick,
  showTrailingButton = true,
  trailingIcon,
}: SettingsTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", padding: "16px 16px 16px 0" }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: "14px", fontWeight: 600, color: "var(--foreground)", textAlign: "left" }}>{label}</p>
        {description && (
          <p style={{ fontSize: "12px", color: "var(--muted)", marginTop: "2px", textAlign: "left" }}>{description}</p>
        )}
      </div>

      {showTrailingButton && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          {value && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                height: "32px",
                paddingLeft: "12px",
                paddingRight: "12px",
                borderRadius: "8px",
                border: "1px solid var(--border)",
              }}
            >
              <span style={{ fontSize: "12px", color: "var(--foreground)", fontWeight: 500, maxWidth: "140px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {value}
              </span>
              <ChevronRight size={16} style={{ color: "var(--muted)", marginLeft: "4px", flexShrink: 0 }} />
            </div>
          )}
          {trailingIcon && !value && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "32px", width: "32px", borderRadius: "8px", border: "1px solid var(--border)", color: "var(--muted)" }}>
              {trailingIcon}
            </div>
          )}
          {!value && !trailingIcon && (
            <ChevronRight size={16} style={{ color: "var(--muted)" }} />
          )}
        </div>
      )}
    </button>
  );
}