"use client";

import { useEffect, useRef } from "react";
import { Copy, X } from "lucide-react";
import { toast } from "@/components/Toaster";

interface SideSheetProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export function SideSheet({ open, onClose, children }: SideSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const prevOverflowRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      prevOverflowRef.current = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = prevOverflowRef.current ?? "";
      prevOverflowRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !panelRef.current) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    const panel = panelRef.current;
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const firstFocusable = focusable[0];
    const lastFocusable = focusable[focusable.length - 1];

    function handleTab(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      if (focusable.length === 0) return;

      if (e.shiftKey) {
        if (document.activeElement === firstFocusable) {
          e.preventDefault();
          lastFocusable.focus();
        }
      } else {
        if (document.activeElement === lastFocusable) {
          e.preventDefault();
          firstFocusable.focus();
        }
      }
    }

    panel.addEventListener("keydown", handleKeyDown);
    panel.addEventListener("keydown", handleTab);
    firstFocusable?.focus();

    return () => {
      panel.removeEventListener("keydown", handleKeyDown);
      panel.removeEventListener("keydown", handleTab);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-foreground/10 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="relative w-full max-w-md h-full bg-surface border-l border-border shadow-2xl flex flex-col animate-slide-in"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-foreground">Cell Details</h2>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center h-7 w-7 text-muted hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-5">{children}</div>
      </div>
    </div>
  );
}

interface CellDetailProps {
  columnName: string;
  columnType: string;
  description?: string;
  value: unknown;
}

export function CellDetail({
  columnName,
  columnType,
  description,
  value,
}: CellDetailProps) {
  const displayValue =
    value == null || value === "" ? "—" : String(value);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value == null ? "" : String(value));
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Failed to copy");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-semibold text-foreground">{columnName}</p>
        {description && (
          <p className="text-xs text-muted mt-0.5">{description}</p>
        )}
      </div>

      <div>
        <p className="text-[11px] font-medium text-muted uppercase tracking-wide mb-1">
          Type
        </p>
        <p className="text-sm text-foreground capitalize">{columnType}</p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-[11px] font-medium text-muted uppercase tracking-wide">
            Value
          </p>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted hover:text-foreground transition-colors"
            aria-label="Copy value"
            data-ph-mask-text="true"
          >
            <Copy className="size-3" />
            <span>Copy</span>
          </button>
        </div>
        <div className="rounded-lg border border-border bg-background px-4 py-3" data-ph-mask-text="true">
          <p className="text-sm text-foreground break-all whitespace-pre-wrap">
            {displayValue}
          </p>
        </div>
      </div>
    </div>
  );
}