"use client";

import type { Header } from "@tanstack/react-table";
import type { DatasetRow, DatasetColumn } from "./types";
import { ColumnIcon } from "./ColumnIcon";
import { floorWidth } from "./utils";

export function ColumnHeader({
  header,
  column,
  isResizing,
  containerHeight,
}: {
  header: Header<DatasetRow, unknown>;
  column?: DatasetColumn;
  isResizing: boolean;
  containerHeight: number;
}) {
  return (
    <div
      className="shrink-0 relative select-none border-r border-border text-left text-xs font-medium tracking-wide text-foreground/70"
      style={{ width: floorWidth(header.getSize()) }}
    >
      {isResizing && (
        <div
          className="absolute top-0 right-0 z-10 w-0.5 bg-foreground/40"
          style={{
            height: containerHeight,
          }}
        />
      )}

      <div
        className="flex w-full items-center gap-1.5"
        style={{ padding: "var(--table-cell-py) var(--table-cell-px)" }}
      >
        {column && <ColumnIcon type={column.type} />}
        {column?.isPrimaryKey && (
          <svg
            className="h-3 w-3 shrink-0 text-amber-500/70"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M12.5 0a3.5 3.5 0 0 0-3.29 4.7L1 12.92V16h3.08l.13-1.85 1.79-.13.13-1.79L7.92 12.1l.13-1.79 1.79-.13L10 8.39A3.5 3.5 0 1 0 12.5 0zm1.17 3.5a1.17 1.17 0 1 1-2.34 0 1.17 1.17 0 0 1 2.34 0z" />
          </svg>
        )}
        <span className="truncate">{column?.name ?? header.id}</span>
      </div>

      <div
        onMouseDown={header.getResizeHandler()}
        onTouchStart={header.getResizeHandler()}
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-foreground/20 active:bg-foreground/30"
      />
    </div>
  );
}
