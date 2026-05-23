import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflowMemorySchema, type WorkflowMemory } from "./types.js";

export function globalMemoryPath(memoryDir: string, fingerprint: string): string {
  return join(memoryDir, `${fingerprint}.json`);
}

/** Migrate v1.1 coarse memory format to scored stats (best-effort). */
function migrateLegacyMemory(raw: Record<string, unknown>): WorkflowMemory {
  const base = workflowMemorySchema.parse({
    prompt_fingerprint: raw.prompt_fingerprint,
    user_prompt: raw.user_prompt,
    repair_loop_count: raw.repair_loop_count ?? 0,
    query_stats: [],
    domain_stats: [],
    agent_goal_stats: [],
    extraction_schema: raw.extraction_schema,
    dedupe_keys: raw.dedupe_keys ?? [],
    diagnoses: raw.diagnoses ?? [],
    strategy_notes: raw.strategy_notes ?? [],
    last_missing_fields: raw.last_missing_fields,
  });

  const successfulDomains = raw.successful_domains as string[] | undefined;
  const failedDomains = raw.failed_domains as string[] | undefined;

  for (const domain of successfulDomains ?? []) {
    base.domain_stats.push({
      domain,
      record_count: 1,
      fetch_failures: 0,
      avg_completeness: 0.7,
      avg_confidence: 0.7,
      last_repair_loop: 0,
    });
  }
  for (const domain of failedDomains ?? []) {
    base.domain_stats.push({
      domain,
      record_count: 0,
      fetch_failures: 1,
      avg_completeness: 0,
      avg_confidence: 0,
      last_repair_loop: 0,
    });
  }

  const successfulQueries = raw.successful_queries as
    | { query: string; phase: string; repair_loop: number }[]
    | undefined;
  for (const item of successfulQueries ?? []) {
    base.query_stats.push({
      query: item.query,
      phase: item.phase,
      repair_loop: item.repair_loop,
      urls_produced: 1,
      urls_with_records: 1,
      record_count: 1,
      avg_completeness: 0.7,
      avg_confidence: 0.7,
      search_page: 0,
      weighted_quality: 0.7,
      page_breakdown: [],
    });
  }

  for (const query of (raw.failed_queries as string[] | undefined) ?? []) {
    base.query_stats.push({
      query,
      phase: "legacy",
      repair_loop: 0,
      urls_produced: 1,
      urls_with_records: 0,
      record_count: 0,
      avg_completeness: 0,
      avg_confidence: 0,
      search_page: 0,
      weighted_quality: 0,
      page_breakdown: [],
    });
  }

  return base;
}

export async function loadPersistentMemory(
  memoryDir: string,
  fingerprint: string,
): Promise<WorkflowMemory | null> {
  try {
    const raw = JSON.parse(
      await readFile(globalMemoryPath(memoryDir, fingerprint), "utf8"),
    ) as Record<string, unknown>;

    if (Array.isArray(raw.query_stats)) {
      return workflowMemorySchema.parse(raw);
    }

    return migrateLegacyMemory(raw);
  } catch {
    return null;
  }
}

export async function savePersistentMemory(
  memoryDir: string,
  memory: WorkflowMemory,
): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  await writeFile(
    globalMemoryPath(memoryDir, memory.prompt_fingerprint),
    `${JSON.stringify(memory, null, 2)}\n`,
    "utf8",
  );
}

export async function saveRunMemory(
  runRoot: string,
  memory: WorkflowMemory,
): Promise<string> {
  const path = join(runRoot, "workflow_memory.json");
  await writeFile(path, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
  return path;
}
