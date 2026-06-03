"use client";

import { memo, type CSSProperties } from "react";
import { areEqual } from "react-window";
import type { Row } from "@tanstack/react-table";
import type { DatasetRow, DatasetColumn } from "./types";
import { CellValue } from "./CellValue";
import { floorWidth } from "./utils";

function IconMaximize2() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
    </svg>
  );
}

export interface DataRowData {
  rows: Row<DatasetRow>[];
  columns: DatasetColumn[];
  columnWidths: number[];
  isSelected: (id: string) => boolean;
  toggleRow: (id: string, shiftKey: boolean) => void;
  onCellExpand: (columnName: string, value: unknown, rowId: string) => void;
  isBuilding: boolean;
  pendingRowIds: Set<string>;
  flashingCells: Set<string>;
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
  const { rows, columns, columnWidths, isSelected, toggleRow, onCellExpand, isBuilding, pendingRowIds, flashingCells } = data;
  const row = rows[index];

  if (!row) {
    const BAR_WIDTHS = [40, 62, 75, 55, 85, 48, 70, 58, 80, 45];
    return (
      <div style={style} className="flex items-center border-b border-border/40">
        <div
          className="shrink-0 border-r border-border"
          style={{ width: floorWidth(columnWidths[0] ?? 40), height: "100%" }}
        />
        {columns.map((col, cellIdx) => {
          const width = floorWidth(columnWidths[cellIdx + 1] ?? 150);
          const barPct = BAR_WIDTHS[(index * columns.length + cellIdx) % BAR_WIDTHS.length];
          return (
            <div
              key={col.name}
              className="shrink-0 overflow-hidden border-r border-border/30 last:border-r-0 flex items-center"
              style={{ width, padding: "var(--table-cell-py) var(--table-cell-px)" }}
            >
              {isBuilding && (
                <div
                  className="h-2.5 animate-pulse rounded-sm bg-foreground/[0.06]"
                  style={{ width: `${barPct}%` }}
                />
              )}
            </div>
          );
        })}
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
          aria-label={`Select row ${index + 1}`}
          aria-pressed={selected}
          className={`relative flex h-5 w-5 items-center justify-center text-[11px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-1 ${
            selected
              ? "rounded-sm bg-foreground text-background"
              : "text-foreground/60 hover:text-foreground"
          }`}
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
        const isPending = pendingRowIds.has(row.original._id);
        const isFlashing = flashingCells.has(`${row.original._id}:${col.name}`);
        return (
          <div
            key={col.name}
            data-ph-mask-text="true"
            className={`group relative shrink-0 overflow-hidden text-ellipsis whitespace-nowrap border-r border-border/30 last:border-r-0 ${
              cellIdx === 0
                ? "font-medium text-foreground"
                : "text-foreground/70"
            }${isFlashing ? " cell-flash" : ""}`}
            style={{
              width,
              padding: "var(--table-cell-py) var(--table-cell-px)",
            }}
          >
            <CellValue value={value} type={col.type} />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCellExpand(col.name, value, row.original._id);
              }}
              className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground p-0.5 rounded bg-foreground/5 hover:bg-foreground/10 text-muted hover:text-foreground transition-all"
              aria-label={`Expand ${col.name}`}
            >
              <IconMaximize2 />
            </button>
            {isPending && <div className="shimmer-overlay absolute inset-0" />}
          </div>
        );
      })}
    </div>
  );
}

export const DataRow = memo(DataRowImpl, areEqual);
