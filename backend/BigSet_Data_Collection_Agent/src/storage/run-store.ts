import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DatasetSpec,
  FetchedPage,
  RunReport,
  SourceCandidate,
} from "../models/schemas.js";

export interface RunPaths {
  runId: string;
  root: string;
  pagesDir: string;
  specPath: string;
  candidatesPath: string;
  /** Final selective view (required fields only, ranked). */
  resultsPath: string;
  /** Full merged dataset before selective filter. */
  resultsFullPath: string;
  evidencePath: string;
  evidenceFullPath: string;
  /** Snapshot after initial search → fetch → extract → merge. */
  initResultsPath: string;
  initEvidencePath: string;
  /** Snapshot after repair pass (written only when repair runs). */
  repairResultsPath: string;
  repairEvidencePath: string;
  reportPath: string;
}

export async function createRunStore(
  baseDir: string,
  runId: string,
): Promise<RunPaths> {
  const root = join(baseDir, runId);
  const pagesDir = join(root, "pages");
  await mkdir(pagesDir, { recursive: true });

  return {
    runId,
    root,
    pagesDir,
    specPath: join(root, "dataset_spec.json"),
    candidatesPath: join(root, "source_candidates.json"),
    resultsPath: join(root, "results.csv"),
    resultsFullPath: join(root, "results_full.csv"),
    evidencePath: join(root, "evidence.jsonl"),
    evidenceFullPath: join(root, "evidence_full.jsonl"),
    initResultsPath: join(root, "init_results.csv"),
    initEvidencePath: join(root, "init_evidence.jsonl"),
    repairResultsPath: join(root, "repair_results.csv"),
    repairEvidencePath: join(root, "repair_evidence.jsonl"),
    reportPath: join(root, "run_report.json"),
  };
}

export async function saveJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function saveDatasetSpec(
  paths: RunPaths,
  spec: DatasetSpec,
): Promise<void> {
  await saveJson(paths.specPath, spec);
}

export async function saveSourceCandidates(
  paths: RunPaths,
  candidates: SourceCandidate[],
): Promise<void> {
  await saveJson(paths.candidatesPath, candidates);
}

export async function saveFetchedPage(
  paths: RunPaths,
  page: FetchedPage,
  index: number,
): Promise<void> {
  const slug = String(index).padStart(3, "0");
  const metaPath = join(paths.pagesDir, `${slug}.meta.json`);
  const textPath = join(paths.pagesDir, `${slug}.md`);

  await saveJson(metaPath, {
    url: page.url,
    final_url: page.final_url,
    title: page.title,
    description: page.description,
    error: page.error,
  });
  await writeFile(textPath, page.text || "", "utf8");
}

export async function saveRunReport(
  paths: RunPaths,
  report: RunReport,
): Promise<void> {
  await saveJson(paths.reportPath, report);
}
