import type { DatasetContext } from "./populate.js";
import type { DatasetSchema } from "./types.js";

/** Maps extraction keys (snake_case, display_name) to dataset column names in Convex. */
export function buildPopulateColumnKeyAliases(
  dataSpec: DatasetSchema,
  context: DatasetContext
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();

  for (const column of context.columns) {
    aliases.set(column.name, column.name);
  }

  for (let index = 0; index < dataSpec.columns.length; index++) {
    const specColumn = dataSpec.columns[index]!;
    const contextColumn =
      context.columns.find((column) => column.name === specColumn.display_name) ??
      context.columns[index];
    if (!contextColumn) {
      continue;
    }

    const targetName = contextColumn.name;
    aliases.set(specColumn.name, targetName);
    if (specColumn.display_name !== specColumn.name) {
      aliases.set(specColumn.display_name, targetName);
    }
  }

  return aliases;
}

export function normalizePopulateRowCellsForDataset(
  cells: Record<string, unknown>,
  aliases: ReadonlyMap<string, string>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(cells)) {
    const targetKey = aliases.get(key) ?? key;
    const existing = normalized[targetKey];
    const existingEmpty =
      existing === null || existing === undefined || existing === "";
    const valueFilled = value !== null && value !== undefined && value !== "";

    if (!(targetKey in normalized) || (existingEmpty && valueFilled)) {
      normalized[targetKey] = value;
    }
  }

  return normalized;
}
