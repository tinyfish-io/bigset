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
  usage?: { inputTokens?: number; outputTokens?: number };
  steps?: unknown[];
}

export class RunMetrics {
  searchCalls = 0;
  fetchCalls = 0;
  /** investigate_row tool calls dispatched by the orchestrator. */
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
    this.orchestrator.inputTokens += result.usage?.inputTokens ?? 0;
    this.orchestrator.outputTokens += result.usage?.outputTokens ?? 0;
    this.orchestrator.steps += result.steps?.length ?? 0;
  }

  addInvestigateResult(result: AgentResult): void {
    this.investigate.inputTokens += result.usage?.inputTokens ?? 0;
    this.investigate.outputTokens += result.usage?.outputTokens ?? 0;
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
