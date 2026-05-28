/**
 * Per-run metrics collector for the populate workflow.
 *
 * A single RunMetrics instance is created at the start of each agentStep,
 * passed by reference into every tool factory and agent builder, and read
 * once at the end to write the runStats Convex record.
 *
 * All operations are synchronous integer increments or field reads — zero
 * I/O, zero meaningful overhead on the hot path.
 */

interface AgentResult {
  // Mastra FullOutput: totalUsage sums across all steps; usage is last-step only.
  // Prefer totalUsage for accurate multi-step accounting.
  totalUsage?: { inputTokens?: number; outputTokens?: number };
  usage?: { inputTokens?: number; outputTokens?: number };
  steps?: unknown[];
}

function tokens(result: AgentResult): { input: number; output: number } {
  const src = result.totalUsage ?? result.usage;
  return {
    input: src?.inputTokens ?? 0,
    output: src?.outputTokens ?? 0,
  };
}

export class RunMetrics {
  searchCalls = 0;
  fetchCalls = 0;
  /** run_subagent tool calls dispatched by the orchestrator. */
  investigateCalls = 0;
  /** Rows successfully inserted across all investigate subagents. */
  rowsInserted = 0;

  readonly orchestrator = { inputTokens: 0, outputTokens: 0, steps: 0 };
  readonly investigate = {
    inputTokens: 0,
    outputTokens: 0,
    steps: 0,
    runs: 0,
  };

  addOrchestratorResult(result: AgentResult): void {
    const { input, output } = tokens(result);
    this.orchestrator.inputTokens += input;
    this.orchestrator.outputTokens += output;
    this.orchestrator.steps += result.steps?.length ?? 0;
  }

  addInvestigateResult(result: AgentResult): void {
    const { input, output } = tokens(result);
    this.investigate.inputTokens += input;
    this.investigate.outputTokens += output;
    this.investigate.steps += result.steps?.length ?? 0;
    this.investigate.runs += 1;
  }

  totals(): { inputTokens: number; outputTokens: number } {
    return {
      inputTokens: this.orchestrator.inputTokens + this.investigate.inputTokens,
      outputTokens:
        this.orchestrator.outputTokens + this.investigate.outputTokens,
    };
  }
}
