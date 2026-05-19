"use client";

import { useRef, useEffect, type RefObject } from "react";
import type { Header } from "@tanstack/react-table";
import type { DatasetRow, DatasetColumn } from "./types";
import { ColumnHeader } from "./ColumnHeader";
import { floorWidth } from "./utils";

export function TableHeader({
  headers,
  columns,
  allState,
  toggleAll,
  resizingColumnId,
  tableContainerRef,
}: {
  headers: Header<DatasetRow, unknown>[];
  columns: DatasetColumn[];
  allState: boolean | "indeterminate";
  toggleAll: () => void;
  resizingColumnId: string | false;
  tableContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const checkboxRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = allState === "indeterminate";
    }
  }, [allState]);

  const selectHeader = headers[0];
  const dataHeaders = headers.slice(1);

  return (
    <div
      className="flex bg-background border-b border-border sticky top-0 z-10"
      style={{ height: "var(--table-header-height)" }}
    >
      {selectHeader && (
        <div
          className="shrink-0 flex items-center justify-center border-r border-border bg-background"
          style={{ width: floorWidth(selectHeader.getSize()) }}
        >
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={allState === true}
            onChange={toggleAll}
            className="h-3.5 w-3.5 accent-foreground cursor-pointer"
          />
        </div>
      )}

      {dataHeaders.map((header, i) => (
        <ColumnHeader
          key={header.id}
          header={header}
          column={columns[i]}
          isResizing={resizingColumnId === header.id}
          tableContainerRef={tableContainerRef}
        />
      ))}
    </div>
  );
}
