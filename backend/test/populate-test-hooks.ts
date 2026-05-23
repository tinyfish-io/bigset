import type { PopulateParallelHooks } from "../src/pipeline/populate-parallel.js";
import type { PopulateExtractionSpec } from "../src/pipeline/populate-extraction-spec.js";
import type { PopulateCandidateRow } from "../src/pipeline/populate-row.js";

export function mockTriageExtractHooks(input: {
  recordsByUrl: Record<string, PopulateCandidateRow[]>;
}): PopulateParallelHooks {
  return {
    triageAndExtractPage: async ({ page, spec }) => {
      const pageUrl = page.final_url || page.url;
      const records = input.recordsByUrl[pageUrl] ?? [];
      return {
        triage: {
          url: page.url,
          final_url: pageUrl,
          title: page.title ?? "",
          status: "extract_now",
          confidence: 1,
          source_data_confidence: 1,
          expected_yield: "complete",
          reasoning: "mock",
        },
        records: records.map((row) => ({
          ...row,
          primaryKey:
            row.primaryKey ||
            String(row.cells[spec.primary_key] ?? "").trim().toLowerCase(),
        })),
      };
    },
    runTinyfishAgentsBatch: async () => [],
  };
}

export function buildMockRow(input: {
  spec: PopulateExtractionSpec;
  entityName: string;
  sourceUrl: string;
  extraCells?: Record<string, string | number | boolean | null>;
  quote?: string;
}): PopulateCandidateRow {
  const cells: Record<string, string | number | boolean | null> = {
    [input.spec.primary_key]: input.entityName,
    source_url: input.sourceUrl,
    ...input.extraCells,
  };
  for (const column of input.spec.columns) {
    if (cells[column.name] === undefined) {
      cells[column.name] = null;
    }
  }
  const quote = input.quote ?? `${input.entityName} evidence`;
  return {
    cells,
    sourceUrls: [input.sourceUrl],
    evidence: [
      {
        columnName: input.spec.primary_key,
        sourceUrl: input.sourceUrl,
        quote,
      },
    ],
    needsReview: true,
    extractionConfidence: 0.9,
    primaryKey: input.entityName.trim().toLowerCase(),
  };
}
