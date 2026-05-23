"use client";

import { memo, type CSSProperties } from "react";
import { areEqual } from "react-window";
import type { Row } from "@tanstack/react-table";
import type { DatasetRow, DatasetColumn } from "./types";
import { CellValue } from "./CellValue";
import { floorWidth } from "./utils";
import { Maximize2 } from "lucide-react";

export interface DataRowData {
  rows: Row<DatasetRow>[];
  columns: DatasetColumn[];
  columnWidths: number[];
  isSelected: (id: string) => boolean;
  toggleRow: (id: string, shiftKey: boolean) => void;
  onCellExpand: (columnName: string, value: unknown, rowId: string) => void;
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
  const { rows, columns, columnWidths, isSelected, toggleRow, onCellExpand } = data;
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
        className="shrink-0 flex items-center justify-center border-r border-border"
        style={{ width: floorWidth(columnWidths[0] ?? 40) }}
      >
        <input
          type="checkbox"
          checked={selected}
          readOnly
          onClick={(e) => toggleRow(row.original._id, e.shiftKey)}
          className="h-3.5 w-3.5 accent-foreground cursor-pointer"
        />
      </div>

      {columns.map((col, cellIdx) => {
        const width = floorWidth(columnWidths[cellIdx + 1] ?? 150);
        const value = row.original.data[col.name];
        return (
          <div
            key={col.name}
            data-ph-mask-text="true"
            className={`group relative shrink-0 overflow-hidden text-ellipsis whitespace-nowrap border-r border-border/30 last:border-r-0 ${
              cellIdx === 0 ? "font-medium text-foreground" : "text-foreground/70"
            }`}
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
              className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-0.5 rounded bg-foreground/5 hover:bg-foreground/10 text-muted hover:text-foreground transition-all"
              aria-label="Expand cell"
            >
              <Maximize2 className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export const DataRow = memo(DataRowImpl, areEqual);
