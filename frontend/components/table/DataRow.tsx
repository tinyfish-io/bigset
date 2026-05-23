"use client";

import { memo, type CSSProperties } from "react";
import { areEqual } from "react-window";
import type { Row } from "@tanstack/react-table";
import type { DatasetRow, DatasetColumn } from "./types";
import { CellValue } from "./CellValue";
import { floorWidth } from "./utils";

export interface DataRowData {
  rows: Row<DatasetRow>[];
  columns: DatasetColumn[];
  columnWidths: number[];
  isSelected: (id: string) => boolean;
  toggleRow: (id: string, shiftKey: boolean) => void;
}

function DataRowImpl({
  data,
  index,
  style,
}: {
  data: DataRowData;
  index: number;
  style: CSSProperties;
}) {
  const { rows, columns, columnWidths, isSelected, toggleRow } = data;
  const row = rows[index];

  if (!row) {
    return (
      <div style={style} className="flex items-center border-b border-border/40">
        <div className="flex-1 px-3 py-2">
          <div className="h-3 w-24 animate-pulse bg-foreground/5" />
        </div>
      </div>
    );
  }

  const selected = isSelected(row.original._id);

  return (
    <div
      style={style}
      className={`flex items-center border-b border-border/40 transition-colors ${
        selected ? "bg-accent/[0.04]" : "hover:bg-foreground/[0.015]"
      }`}
    >
      <div
        className="group/shrinkcell shrink-0 flex items-center justify-center border-r border-border"
        style={{ width: floorWidth(columnWidths[0] ?? 40) }}
      >
        <button
          type="button"
          onClick={(e) => toggleRow(row.original._id, e.shiftKey)}
          className={`relative flex h-5 w-5 items-center justify-center text-[11px] leading-none transition-colors ${
            selected
              ? "rounded-sm bg-foreground text-background"
              : "text-foreground/60 hover:text-foreground"
          }`}
          aria-label={`Select row ${index + 1}`}
        >
          <span
            className={`transition-opacity ${
              selected ? "hidden" : "group-hover/shrinkcell:hidden"
            }`}
          >
            {index + 1}
          </span>
          <span
            className={`absolute flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border transition-opacity ${
              selected
                ? "border-foreground bg-foreground text-background"
                : "border-foreground/35 bg-background opacity-0 group-hover/shrinkcell:opacity-100"
            }`}
          >
            {selected ? <span className="text-[10px] leading-none">✓</span> : null}
          </span>
        </button>
      </div>

      {columns.map((col, cellIdx) => {
        const width = floorWidth(columnWidths[cellIdx + 1] ?? 150);
        const value = row.original.data[col.name];
        return (
          <div
            key={col.name}
            // Session-replay masking: the cell VALUE could be anything
            // (scraped emails, prices, internal data). Mask the text in
            // replays. Layout, column structure, and clicks remain
            // visible — enough to diagnose UI issues without leaking
            // user data. See lib/analytics.ts session_recording config.
            data-ph-mask-text="true"
            className={`shrink-0 overflow-hidden text-ellipsis whitespace-nowrap border-r border-border/30 last:border-r-0 ${
              cellIdx === 0
                ? "font-medium text-foreground"
                : "text-foreground/70"
            }`}
            style={{
              width,
              padding: "var(--table-cell-py) var(--table-cell-px)",
            }}
          >
            <CellValue value={value} type={col.type} />
          </div>
        );
      })}
    </div>
  );
}

export const DataRow = memo(DataRowImpl, areEqual);
