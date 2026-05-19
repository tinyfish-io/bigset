"use client";

import type { RefObject } from "react";
import type { Header } from "@tanstack/react-table";
import type { DatasetRow, DatasetColumn } from "./types";
import { ColumnIcon } from "./ColumnIcon";
import { floorWidth } from "./utils";

export function ColumnHeader({
  header,
  column,
  isResizing,
  tableContainerRef,
}: {
  header: Header<DatasetRow, unknown>;
  column?: DatasetColumn;
  isResizing: boolean;
  tableContainerRef: RefObject<HTMLDivElement | null>;
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
            height: tableContainerRef.current?.offsetHeight || "100%",
          }}
        />
      )}

      <div
        className="flex w-full items-center gap-1.5"
        style={{ padding: "var(--table-cell-py) var(--table-cell-px)" }}
      >
        {column && <ColumnIcon type={column.type} />}
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
