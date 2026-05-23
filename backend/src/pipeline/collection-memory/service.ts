import {
  createEmptyCollectionMemory,
  loadCollectionMemory,
  saveCollectionMemory,
} from "./store.js";
import { recordAgentVisitedUrl } from "./mutations.js";
import type { PopulateCollectionMemory } from "./types.js";
import type { PopulateSourceTriageResult } from "../types.js";
import type { BrowserAgentRunResult } from "../populate-browser-agent.js";
import type { BrowserAgentProvider } from "./types.js";
import { resolvePopulateCollectionMemoryConfig } from "../populate-collection-memory-config.js";

export class PopulateCollectionMemoryService {
  private memory: PopulateCollectionMemory | null = null;

  constructor(
    private readonly input: {
      datasetId: string;
      userPrompt: string;
      memoryDir?: string;
    }
  ) {}

  get snapshot(): PopulateCollectionMemory | null {
    return this.memory;
  }

  async load(): Promise<PopulateCollectionMemory> {
    const config = resolvePopulateCollectionMemoryConfig();
    const memoryDir = this.input.memoryDir ?? config.memoryDir;
    const existing = await loadCollectionMemory(memoryDir, this.input.datasetId);
    this.memory =
      existing ??
      createEmptyCollectionMemory({
        datasetId: this.input.datasetId,
        userPrompt: this.input.userPrompt,
        maxRepairLoops: config.maxRepairLoops,
      });
    return this.memory;
  }

  /** Best-effort persistence — populate must succeed even if disk is unavailable. */
  async save(): Promise<boolean> {
    if (!this.memory) {
      return false;
    }
    const config = resolvePopulateCollectionMemoryConfig();
    const memoryDir = this.input.memoryDir ?? config.memoryDir;
    try {
      await saveCollectionMemory(memoryDir, this.memory);
      return true;
    } catch (error) {
      console.warn(
        `[collection-memory] Failed to persist memory for dataset ${this.input.datasetId}:`,
        error instanceof Error ? error.message : error
      );
      return false;
    }
  }

  recordAgentVisit(input: {
    url: string;
    finalUrl?: string;
    provider: BrowserAgentProvider;
    goal: string;
    run: BrowserAgentRunResult;
    triage?: PopulateSourceTriageResult;
  }): void {
    if (!this.memory) {
      throw new Error("PopulateCollectionMemoryService.load() must be called first");
    }
    this.memory = recordAgentVisitedUrl(this.memory, input);
  }
}
