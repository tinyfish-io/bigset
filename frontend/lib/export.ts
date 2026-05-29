/**
 * Client-side exporters for dataset views.
 *
 * CSV: hand-rolled, no dependencies. Tiny payload, fast.
 * XLSX: dynamically imports `write-excel-file` on demand so users who
 *       never click "Export XLSX" never download it.
 */

export interface ExportColumn {
  name: string;
}

export interface ExportRow {
  data: Record<string, unknown>;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

function stringifyCellValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function neutralizeSpreadsheetFormula(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

type ExcelCellValue = string | number | boolean | Date | null;

function toExcelCellValue(value: unknown): ExcelCellValue {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  return neutralizeSpreadsheetFormula(stringifyCellValue(value));
}

function csvEscape(value: unknown): string {
  if (value == null) return "";
  const str = neutralizeSpreadsheetFormula(stringifyCellValue(value));
  // RFC 4180: fields containing comma, quote, CR, or LF must be quoted;
  // quotes inside the field are doubled.
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCSV(
  columns: ExportColumn[],
  rows: ExportRow[],
): string {
  const header = columns.map((c) => csvEscape(c.name)).join(",");
  const body = rows
    .map((row) =>
      columns.map((c) => csvEscape(row.data[c.name])).join(","),
    )
    .join("\n");
  // BOM lets Excel open UTF-8 CSV with non-ASCII names correctly.
  return "﻿" + header + "\n" + body + "\n";
}

// ── Filename helpers ────────────────────────────────────────────────────────

function safeFilename(name: string, ext: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "dataset";
  return `${base}.${ext}`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Some browsers require the anchor to be in the DOM.
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Public API ──────────────────────────────────────────────────────────────

export function downloadCSV(
  datasetName: string,
  columns: ExportColumn[],
  rows: ExportRow[],
): void {
  const csv = buildCSV(columns, rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, safeFilename(datasetName, "csv"));
}

export async function downloadXLSX(
  datasetName: string,
  columns: ExportColumn[],
  rows: ExportRow[],
): Promise<void> {
  const { default: writeExcelFile } = await import("write-excel-file/browser");

  const sheetData = [
    columns.map((column) => neutralizeSpreadsheetFormula(column.name)),
    ...rows.map((row) =>
      columns.map((column) => toExcelCellValue(row.data[column.name])),
    ),
  ];

  await writeExcelFile(sheetData).toFile(safeFilename(datasetName, "xlsx"));
}
