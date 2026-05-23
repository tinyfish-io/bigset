import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { workflowMemorySchema, type WorkflowMemory } from "../memory/types.js";
import {
  datasetSpecSchema,
  extractedRecordSchema,
  runReportSchema,
  type DatasetSpec,
  type ExtractedRecord,
  type RunReport,
} from "../models/schemas.js";

export interface LoadedRun {
  runId: string;
  root: string;
  spec: DatasetSpec;
  report: RunReport;
  records: ExtractedRecord[];
  memory: WorkflowMemory | null;
}

export function runRoot(baseDir: string, runId: string): string {
  return join(baseDir, runId);
}

export async function loadRunForRefresh(
  baseDir: string,
  runId: string,
): Promise<LoadedRun> {
  const root = runRoot(baseDir, runId);
  const spec = datasetSpecSchema.parse(
    JSON.parse(await readFile(join(root, "dataset_spec.json"), "utf8")),
  );
  const report = runReportSchema.parse(
    JSON.parse(await readFile(join(root, "run_report.json"), "utf8")),
  );

  let memory: WorkflowMemory | null = null;
  try {
    memory = workflowMemorySchema.parse(
      JSON.parse(await readFile(join(root, "workflow_memory.json"), "utf8")),
    );
  } catch {
    memory = null;
  }

  const records = await loadRecordsFromEvidence(join(root, "evidence.jsonl"));
  const fallback =
    records.length > 0
      ? records
      : await loadRecordsFromEvidence(join(root, "evidence_full.jsonl"));

  return {
    runId,
    root,
    spec,
    report,
    records: fallback,
    memory,
  };
}

export async function loadRecordsFromEvidence(
  path: string,
): Promise<ExtractedRecord[]> {
  try {
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const records: ExtractedRecord[] = [];
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        row: ExtractedRecord["row"];
        evidence: ExtractedRecord["evidence"];
        source_urls: string[];
        extraction_confidence?: number;
      };
      records.push(
        extractedRecordSchema.parse({
          row: parsed.row,
          evidence: parsed.evidence ?? [],
          source_urls: parsed.source_urls ?? [],
          extraction_confidence: parsed.extraction_confidence,
        }),
      );
    }
    return records;
  } catch {
    return [];
  }
}
