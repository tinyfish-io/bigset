"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { DatasetColumn } from "@/components/table/types";

function IconX() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
    </svg>
  );
}
function IconCopy() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5"/>
    </svg>
  );
}
function IconExternalLink() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    </svg>
  );
}

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-foreground/20 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Modal */}
      <div
        ref={panelRef}
        aria-labelledby="cell-detail-title"
        className="relative w-full max-w-lg max-h-[80vh] bg-surface border border-border rounded-xl shadow-2xl flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 id="cell-detail-title" className="text-sm font-semibold text-foreground">Cell Detail</h2>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center h-7 w-7 text-muted hover:text-foreground transition-colors rounded"
            aria-label="Close"
          >
            <IconX />
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

function isValidHttpUrl(src: string): boolean {
  try {
    const { protocol } = new URL(src);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function CellDetail({ column, value, sources }: CellDetailProps) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayValue = value == null || value === "" ? "—" : String(value);

  // Clear any pending timer when the component unmounts to avoid calling
  // setCopied on an already-gone component.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value == null ? "" : String(value));
      setCopied(true);
      if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. non-HTTPS dev); silently ignore.
    }
  }, [value]);

  return (
    <div className="space-y-6">
      {/* Column name + description */}
      <div>
        <p className="text-sm font-semibold text-foreground">{column.name}</p>
        {column.description && (
          <p className="text-xs text-muted mt-0.5">{column.description}</p>
        )}
      </div>

      {/* Value */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[11px] font-medium text-muted uppercase tracking-wide">
            Value <span className="normal-case">({column.type})</span>
          </p>
          <button
            type="button"
            onClick={() => { void handleCopy(); }}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted hover:text-foreground transition-colors"
            aria-label="Copy value"
          >
            {copied
              ? <><span className="text-green-500"><IconCheck /></span><span className="text-green-500">Copied</span></>
              : <><IconCopy /><span>Copy</span></>
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
              <li key={src || i}>
                {isValidHttpUrl(src) ? (
                  <a
                    href={src}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-start gap-1.5 text-xs text-link hover:underline break-all"
                    data-ph-mask-text="true"
                  >
                    <span className="mt-0.5 shrink-0"><IconExternalLink /></span>
                    {src}
                  </a>
                ) : (
                  <span className="flex items-start gap-1.5 text-xs text-muted break-all" data-ph-mask-text="true">
                    <span className="mt-0.5 shrink-0"><IconExternalLink /></span>
                    {src}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
