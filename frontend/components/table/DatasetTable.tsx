"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  createColumnHelper,
  type ColumnDef,
} from "@tanstack/react-table";
import { FixedSizeList } from "react-window";
import type { DatasetMeta, DatasetRow, DatasetColumn } from "./types";
import { useSelection } from "./use-selection";
import { usePersistedColumnWidths } from "./use-persisted-widths";
import { TableHeader } from "./TableHeader";
import { DataRow, type DataRowData } from "./DataRow";

const CHECKBOX_COL_WIDTH = 40;
const DEFAULT_COL_WIDTH = 180;
const MIN_COL_WIDTH = 80;
const ROW_HEIGHT = 34;

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
    }),
  );

  return [selectCol, ...dataCols];
}

export function DatasetTable({
  dataset,
  rows,
  datasetId,
}: {
  dataset: DatasetMeta;
  rows: DatasetRow[];
  datasetId: string;
}) {
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<FixedSizeList>(null);
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

  const rowIds = useMemo(() => rows.map((r) => r._id), [rows]);
  const selection = useSelection(rowIds);
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
  const totalWidth = columnWidths.reduce((sum, w) => sum + w, 0);
  const resizingColumnId = table.getState().columnSizingInfo.isResizingColumn;

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
    }),
    [tableRows, dataset.columns, columnWidths, selection.has, toggleRow],
  );

  return (
    <div
      ref={tableContainerRef}
      className="flex-1 overflow-auto relative"
      style={{ fontSize: "13px" }}
      onMouseUp={() => {
        if (resizingColumnId) persistWidths();
      }}
    >
      <div style={{ minWidth: totalWidth }}>
        <TableHeader
          headers={headers}
          columns={dataset.columns}
          allState={selection.allState}
          toggleAll={selection.toggleAll}
          resizingColumnId={resizingColumnId}
          tableContainerRef={tableContainerRef}
        />

        <FixedSizeList
          ref={listRef}
          height={Math.max(containerHeight - 32, 200)}
          itemCount={tableRows.length}
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
