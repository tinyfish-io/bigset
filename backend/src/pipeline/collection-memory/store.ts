import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { promptFingerprint } from "./fingerprint.js";
import {
  populateCollectionMemorySchema,
  repairLoopStateSchema,
  type AgentVisitedUrlEntry,
  type PopulateCollectionMemory,
  type RepairLoopState,
} from "./types.js";

export function collectionMemoryPath(memoryDir: string, datasetId: string): string {
  return join(memoryDir, `${datasetId}.json`);
}

export function createEmptyCollectionMemory(input: {
  datasetId: string;
  userPrompt: string;
  maxRepairLoops?: number;
}): PopulateCollectionMemory {
  const now = new Date().toISOString();
  return populateCollectionMemorySchema.parse({
    version: 1,
    dataset_id: input.datasetId,
    prompt_fingerprint: promptFingerprint(input.userPrompt),
    user_prompt: input.userPrompt,
    repair_loop: repairLoopStateSchema.parse({
      current_loop: 0,
      max_loops: input.maxRepairLoops ?? 3,
      status: "idle",
      notes: [],
    }),
    agent_visited_urls: [],
    updated_at: now,
  });
}

export async function loadCollectionMemory(
  memoryDir: string,
  datasetId: string
): Promise<PopulateCollectionMemory | null> {
  try {
    const raw = JSON.parse(
      await readFile(collectionMemoryPath(memoryDir, datasetId), "utf8")
    ) as unknown;
    return populateCollectionMemorySchema.parse(raw);
  } catch {
    return null;
  }
}

export async function saveCollectionMemory(
  memoryDir: string,
  memory: PopulateCollectionMemory
): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  const payload: PopulateCollectionMemory = {
    ...memory,
    updated_at: new Date().toISOString(),
  };
  await writeFile(
    collectionMemoryPath(memoryDir, memory.dataset_id),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8"
  );
}

export function findLatestAgentVisit(
  memory: PopulateCollectionMemory,
  url: string,
  provider?: AgentVisitedUrlEntry["provider"]
): AgentVisitedUrlEntry | undefined {
  const normalized = url.trim();
  const matches = memory.agent_visited_urls.filter((entry) => {
    if (provider && entry.provider !== provider) {
      return false;
    }
    return entry.url === normalized || entry.final_url === normalized;
  });
  return matches.at(-1);
}

export function latestTinyfishEmittedProcess(
  memory: PopulateCollectionMemory,
  url: string
): Record<string, unknown> | undefined {
  const visit = findLatestAgentVisit(memory, url, "tinyfish");
  return visit?.emitted_process;
}
