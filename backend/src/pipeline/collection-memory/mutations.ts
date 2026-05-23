import type { PopulateSourceTriageResult } from "../types.js";
import { extractEmittedProcessFromAgentResult } from "../populate-browser-agent.js";
import type { BrowserAgentRunResult } from "../populate-browser-agent.js";
import type {
  AgentVisitedUrlEntry,
  BrowserAgentProvider,
  PopulateCollectionMemory,
  RepairLoopState,
} from "./types.js";

export function recordAgentVisitedUrl(
  memory: PopulateCollectionMemory,
  input: {
    url: string;
    finalUrl?: string;
    provider: BrowserAgentProvider;
    goal: string;
    run: BrowserAgentRunResult;
    repairLoop?: number;
    triage?: PopulateSourceTriageResult;
  }
): PopulateCollectionMemory {
  const emittedProcess =
    input.provider === "tinyfish"
      ? extractEmittedProcessFromAgentResult(input.run.result)
      : input.run.result
        ? extractEmittedProcessFromAgentResult(input.run.result)
        : undefined;

  const entry: AgentVisitedUrlEntry = {
    url: input.url,
    final_url: input.finalUrl,
    repair_loop: input.repairLoop ?? memory.repair_loop.current_loop,
    provider: input.provider,
    goal: input.goal,
    run_id: input.run.run_id,
    status: input.run.status,
    visited_at: new Date().toISOString(),
    error: input.run.error,
    emitted_process: emittedProcess,
    triage_status: input.triage?.status,
    suggested_action: input.triage?.suggested_action,
  };

  return {
    ...memory,
    agent_visited_urls: [...memory.agent_visited_urls, entry],
    updated_at: new Date().toISOString(),
  };
}

/** Reserved for the future repair loop — updates metadata only. */
export function markRepairLoopPending(memory: PopulateCollectionMemory): PopulateCollectionMemory {
  return {
    ...memory,
    repair_loop: {
      ...memory.repair_loop,
      status: "pending",
      notes: [
        ...memory.repair_loop.notes,
        "Repair loop scheduled (not implemented in populate pipeline yet).",
      ],
    },
    updated_at: new Date().toISOString(),
  };
}

export function patchRepairLoopState(
  memory: PopulateCollectionMemory,
  patch: Partial<RepairLoopState>
): PopulateCollectionMemory {
  return {
    ...memory,
    repair_loop: {
      ...memory.repair_loop,
      ...patch,
    },
    updated_at: new Date().toISOString(),
  };
}
