import { dirname, join } from "node:path";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  return TRUTHY.has(raw.trim().toLowerCase());
}

const DEFAULT_MEMORY_DIR = ".bigset/collection-memory";
const DEFAULT_MAX_REPAIR_LOOPS = 3;
const DEFAULT_ENABLE_COLLECTION_MEMORY = true;

export interface PopulateCollectionMemoryConfig {
  memoryDir: string;
  enabled: boolean;
  maxRepairLoops: number;
}

function resolveDefaultMemoryDir(env: NodeJS.ProcessEnv): string {
  const recipeStoreDir = env.POPULATE_RECIPE_STORE_DIR?.trim();
  if (recipeStoreDir) {
    return join(dirname(recipeStoreDir), "collection-memory");
  }
  return DEFAULT_MEMORY_DIR;
}

export function resolvePopulateCollectionMemoryConfig(
  env: NodeJS.ProcessEnv = process.env
): PopulateCollectionMemoryConfig {
  return {
    memoryDir:
      env.POPULATE_COLLECTION_MEMORY_DIR?.trim() || resolveDefaultMemoryDir(env),
    enabled: readBoolean(env.POPULATE_ENABLE_COLLECTION_MEMORY, DEFAULT_ENABLE_COLLECTION_MEMORY),
    maxRepairLoops: readPositiveInt(env.POPULATE_MAX_REPAIR_LOOPS, DEFAULT_MAX_REPAIR_LOOPS),
  };
}
