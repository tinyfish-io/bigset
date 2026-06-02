"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  createColumnHelper,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { FixedSizeList } from "react-window";
import type { DatasetMeta, DatasetRow, DatasetColumn } from "./types";
import type { useSelection } from "./use-selection";
import { usePersistedColumnWidths } from "./use-persisted-widths";
import { TableHeader } from "./TableHeader";
import { DataRow, type DataRowData } from "./DataRow";
import { useRowChangeDetection } from "./use-row-change-detection";

type Selection = ReturnType<typeof useSelection>;

const CHECKBOX_COL_WIDTH = 40;
const DEFAULT_COL_WIDTH = 180;
const MIN_COL_WIDTH = 80;
const ROW_HEIGHT = 34;
const GHOST_ROW_COUNT = 50;
const LAST_COLUMN_RESIZE_GUTTER = 160;

const columnHelper = createColumnHelper<DatasetRow>();

function buildColumns(
  datasetColumns: DatasetColumn[],
  storedWidths: Record<string, number>,
): ColumnDef<DatasetRow, unknown>[] {
  const selectCol = columnHelper.display({
    id: "_select",
    size: CHECKBOX_COL_WIDTH,
    minSize: CHECKBOX_COL_WIDTH,
    maxSize: CHECKBOX_COL_WIDTH,
    enableResizing: false,
  });

  const dataCols = datasetColumns.map((col) =>
    columnHelper.accessor((row) => row.data[col.name], {
      id: col.name,
      header: col.name,
      size: storedWidths[col.name] ?? DEFAULT_COL_WIDTH,
      minSize: MIN_COL_WIDTH,
      // Custom sort: strip currency/thousands formatting then compare numerically;
      // fall back to case-insensitive locale comparison for non-numeric values.
      // TanStack's built-in "alphanumeric" sorts digit chunks individually so
      // "$1,234" and "1234.56" don't sort correctly as numbers.
      sortingFn: (rowA, rowB, columnId) => {
        const a = rowA.getValue(columnId);
        const b = rowB.getValue(columnId);
        const toNum = (v: unknown): number => {
          if (typeof v === "number") return v;
          if (typeof v !== "string") return Number.NaN;
          const n = Number(v.replace(/[^0-9.-]/g, ""));
          return Number.isFinite(n) ? n : Number.NaN;
        };
        const na = toNum(a);
        const nb = toNum(b);
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
        return String(a ?? "").localeCompare(String(b ?? ""), undefined, {
          sensitivity: "base",
        });
      },
    }),
  );

  return [selectCol, ...dataCols];
}

/**
 * Renders the dataset's rows in a TanStack-Table + react-window grid.
 *
 * `selection` is owned by the parent page (so the page can export only
 * selected rows). Without it, this component is a pure view of rows +
 * columns; with it, header/row checkboxes drive selection through the
 * parent.
 */
export function DatasetTable({
  dataset,
  rows,
  datasetId,
  selection,
  onCellExpand,
}: {
  dataset: DatasetMeta;
  rows: DatasetRow[];
  datasetId: string;
  selection: Selection;
  onCellExpand: (columnName: string, value: unknown, rowId: string) => void;
}) {
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const previousResizingColumnIdRef = useRef<string | false>(false);
  const [containerHeight, setContainerHeight] = useState(600);

  useEffect(() => {
    const el = tableContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const [sorting, setSorting] = useState<SortingState>([]);

  const [storedWidths, setStoredWidths] = usePersistedColumnWidths(datasetId);

  const columns = useMemo(
    () => buildColumns(dataset.columns, storedWidths),
    [dataset.columns, storedWidths],
  );

  const table = useReactTable({
    data: rows,
    columns,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
    getRowId: (row) => row._id,
  });

  const persistWidths = useCallback(() => {
    const sizing = table.getState().columnSizing;
    const next: Record<string, number> = { ...storedWidths };
    for (const [id, size] of Object.entries(sizing)) {
      if (id !== "_select") next[id] = size;
    }
    setStoredWidths(next);
  }, [table, storedWidths, setStoredWidths]);

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const tableRows = table.getRowModel().rows;
  const columnWidths = useMemo(() => headers.map((h) => h.getSize()), [headers]);
  const isBuilding = dataset.status === "building";
  const { flashingCells, pendingRowIds } = useRowChangeDetection(rows);
  const displayCount = isBuilding ? Math.max(tableRows.length, GHOST_ROW_COUNT) : tableRows.length;
  const totalWidth = columnWidths.reduce((sum, w) => sum + w, 0);
  const tableContentWidth = totalWidth + LAST_COLUMN_RESIZE_GUTTER;
  const resizingColumnId = table.getState().columnSizingInfo.isResizingColumn;

  useEffect(() => {
    if (previousResizingColumnIdRef.current && !resizingColumnId) {
      persistWidths();
    }
    previousResizingColumnIdRef.current = resizingColumnId;
  }, [resizingColumnId, persistWidths]);

  const toggleRow = useCallback(
    (id: string, shiftKey: boolean) => {
      if (shiftKey) selection.shiftToggle(id);
      else selection.toggle(id);
    },
    [selection],
  );

  const itemData: DataRowData = useMemo(
    () => ({
      rows: tableRows,
      columns: dataset.columns,
      columnWidths,
      isSelected: selection.has,
      toggleRow,
      onCellExpand,
      isBuilding,
      pendingRowIds,
      flashingCells,
    }),
    [tableRows, dataset.columns, columnWidths, selection.has, toggleRow, onCellExpand, isBuilding, pendingRowIds, flashingCells],
  );

  return (
    <div
      ref={tableContainerRef}
      className="flex-1 overflow-auto relative"
      style={{ fontSize: "13px" }}
    >
      <div style={{ minWidth: tableContentWidth }}>
        <TableHeader
          headers={headers}
          columns={dataset.columns}
          allState={selection.allState}
          toggleAll={selection.toggleAll}
          resizingColumnId={resizingColumnId}
          containerHeight={containerHeight}
        />

        <FixedSizeList
          height={Math.max(containerHeight - 32, 200)}
          itemCount={displayCount}
          itemSize={ROW_HEIGHT}
          width="100%"
          itemData={itemData}
          overscanCount={10}
        >
          {DataRow}
        </FixedSizeList>
      </div>
    </div>
  );
}
