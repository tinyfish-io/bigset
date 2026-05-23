import type { DatasetContext } from "./populate.js";
import type { ColumnDefinition, DatasetSchema } from "./types.js";

export interface PopulateExtractionSpec {
  intent_summary: string;
  row_grain: string;
  primary_key: string;
  dedupe_keys: string[];
  columns: Array<{
    name: string;
    type: string;
    description: string;
  }>;
}

export function buildPopulateExtractionSpec(input: {
  context: DatasetContext;
  dataSpec: DatasetSchema;
}): PopulateExtractionSpec {
  return {
    intent_summary: input.context.description,
    row_grain: input.dataSpec.description,
    primary_key: input.dataSpec.primary_key,
    dedupe_keys: [input.dataSpec.primary_key],
    columns: input.dataSpec.columns.map(mapColumn),
  };
}

function mapColumn(column: ColumnDefinition) {
  return {
    name: column.name,
    type: column.type,
    description: column.description,
  };
}
