import type { Dataset, DatasetRow } from "./client.js";

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildCsv(dataset: Dataset, rows: DatasetRow[]): string {
  const header = dataset.columns.map((column) => csvEscape(column.name)).join(",");
  const body = rows.map((row) =>
    dataset.columns
      .map((column) => csvEscape(row.data[column.name]))
      .join(","),
  );
  return [header, ...body].join("\n");
}
