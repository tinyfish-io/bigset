"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Check, ExternalLink, X } from "lucide-react";
import type { DatasetColumn } from "@/components/table/types";

/* ------------------------------------------------------------------ */
/*  Shell                                                               */
/* ------------------------------------------------------------------ */

interface SideSheetProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export function SideSheet({ open, onClose, children }: SideSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Keyboard: Escape closes, Tab stays trapped inside.
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const panel = panelRef.current;

    const focusable = panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable[0]?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }

    panel.addEventListener("keydown", onKey);
    return () => panel.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-foreground/10 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        className="relative w-full max-w-md h-full bg-surface border-l border-border shadow-2xl flex flex-col animate-slide-in"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-foreground">Cell Detail</h2>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center h-7 w-7 text-muted hover:text-foreground transition-colors rounded"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Content                                                             */
/* ------------------------------------------------------------------ */

interface CellDetailProps {
  column: DatasetColumn;
  value: unknown;
  /** Row-level sources stored by the populate agent. */
  sources?: string[];
}

export function CellDetail({ column, value, sources }: CellDetailProps) {
  const [copied, setCopied] = useState(false);
  const displayValue = value == null || value === "" ? "—" : String(value);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value == null ? "" : String(value));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. non-HTTPS dev); silently ignore.
    }
  }

  return (
    <div className="space-y-6">
      {/* Column name + description */}
      <div>
        <p className="text-sm font-semibold text-foreground">{column.name}</p>
        {column.description && (
          <p className="text-xs text-muted mt-0.5">{column.description}</p>
        )}
      </div>

      {/* Type */}
      <div>
        <p className="text-[11px] font-medium text-muted uppercase tracking-wide mb-1">
          Type
        </p>
        <p className="text-sm text-foreground capitalize">{column.type}</p>
      </div>

      {/* Value */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[11px] font-medium text-muted uppercase tracking-wide">
            Value
          </p>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted hover:text-foreground transition-colors"
            aria-label="Copy value"
          >
            {copied
              ? <><Check className="size-3 text-green-500" /><span className="text-green-500">Copied</span></>
              : <><Copy className="size-3" /><span>Copy</span></>
            }
          </button>
        </div>
        <div
          className="rounded-lg border border-border bg-background px-4 py-3"
          data-ph-mask-text="true"
        >
          <p className="text-sm text-foreground break-all whitespace-pre-wrap">
            {displayValue}
          </p>
        </div>
      </div>

      {/* Sources */}
      {sources && sources.length > 0 && (
        <div>
          <p className="text-[11px] font-medium text-muted uppercase tracking-wide mb-1.5">
            Sources
          </p>
          <ul className="space-y-1.5">
            {sources.map((src, i) => (
              <li key={i}>
                <a
                  href={src}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-1.5 text-xs text-link hover:underline break-all"
                  data-ph-mask-text="true"
                >
                  <ExternalLink className="size-3 mt-0.5 shrink-0" />
                  {src}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
