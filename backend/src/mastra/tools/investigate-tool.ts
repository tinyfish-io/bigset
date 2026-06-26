import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { convex, internal } from "../../convex.js";
import { buildInvestigateAgent } from "../agents/investigate.js";
import { validatePrimaryKeySources } from "./dataset-tools.js";
import type { AuthContext } from "../workflows/populate.js";
import type { CodificationProfile, PopulateColumn } from "../../pipeline/populate.js";
import type { RunMetrics } from "../run-metrics.js";
import {
  getSignal,
  isAbortLikeError,
  isDatasetRunAborted,
  throwIfDatasetRunAborted,
} from "../../abort-registry.js";
import {
  tryRowExtractorDraft,
  type RowExtractorDraftResult,
} from "../../row-extractors/try-row-extractor.js";
import type { LlmProviderConfig } from "../../config/llm.js";
import { AGENT_MAX_OUTPUT_TOKENS } from "../../config/agent-output-tokens.js";

const keyValueSchema = z.object({
  column: z.string().min(1),
  value: z.string().min(1),
});

const investigateInputSchema = z.object({
  entity_hint: z
    .string()
    .describe(
      "What entity to look for, e.g. 'head of GTM at Appcharge' or 'Starbucks coffee products on Amazon'",
    ),
  primary_keys: z
    .array(keyValueSchema)
    .min(1, "primary_keys must include at least one primary-key value")
    .describe(
      'REQUIRED: primary key values as {"column": "column_name", "value": "value"} entries. e.g. [{"column": "company_name", "value": "Stripe"}]. You MUST provide at least the primary key values you have found.',
    ),
  context: z
    .string()
    .describe(
      "All partial data already found: field values, URLs, snippets from search results",
    ),
  urls: z
    .array(z.string())
    .optional()
    .describe("Pages that likely contain this row's data — pass anything promising"),
  notes: z
    .string()
    .optional()
    .describe(
      "Extra clues from previous subagents or the orchestrator that might help",
    ),
});

const investigateOutputSchema = z.object({
  inserted: z.boolean(),
  row_summary: z.string().optional(),
  clues: z.string().optional(),
  reason: z.string(),
});

const queueSubagentsInputSchema = z.object({
  candidates: z
    .array(investigateInputSchema)
    .min(1)
    .max(50)
    .describe("Candidate rows to enqueue for background investigation."),
});

const queueSubagentsOutputSchema = z.object({
  queued: z.number(),
  pending: z.number(),
  active: z.number(),
  completed: z.number(),
  reason: z.string().optional(),
});

const drainSubagentsOutputSchema = z.object({
  completed: z.number(),
  inserted: z.number(),
  failed: z.number(),
  pending: z.number(),
  active: z.number(),
  reasons: z.array(z.string()),
});

interface DatasetContextForExtractor {
  datasetName: string;
  description: string;
  retrievalStrategy?: "search_fetch" | "browser" | "hybrid";
  sourceHint?: string;
  codificationProfile?: CodificationProfile;
}

type InvestigateLead = z.infer<typeof investigateInputSchema>;
type InvestigateResult = z.infer<typeof investigateOutputSchema>;
type ProcessLead = (
  lead: InvestigateLead,
  abortSignal?: AbortSignal,
) => Promise<InvestigateResult>;

interface QueueSummary {
  completed: number;
  inserted: number;
  failed: number;
  pending: number;
  active: number;
  reasons: string[];
}

class SubagentQueue {
  private readonly controller = new AbortController();
  private readonly waiting: Array<{
    lead: InvestigateLead;
    resolve: (result: InvestigateResult) => void;
  }> = [];
  private readonly promises: Promise<InvestigateResult>[] = [];
  private readonly completed: InvestigateResult[] = [];
  private readonly abortListener?: () => void;
  private active = 0;
  private canceledReason: string | undefined;

  constructor(
    private readonly concurrency: number,
    private readonly processLead: ProcessLead,
    private readonly abortSignal?: AbortSignal,
  ) {
    if (abortSignal) {
      this.abortListener = () => this.cancel("Run was stopped");
      abortSignal.addEventListener("abort", this.abortListener, { once: true });
      if (abortSignal.aborted) this.cancel("Run was stopped");
    }
  }

  enqueue(lead: InvestigateLead): void {
    const promise = new Promise<InvestigateResult>((resolve) => {
      if (this.canceledReason) {
        const result = this.canceledResult();
        this.completed.push(result);
        resolve(result);
        return;
      }
      this.waiting.push({ lead, resolve });
      this.pump();
    });
    this.promises.push(promise);
  }

  enqueueMany(leads: InvestigateLead[]): void {
    for (const lead of leads) this.enqueue(lead);
  }

  snapshot(): QueueSummary {
    return this.toSummary();
  }

  cancel(reason: string): void {
    if (this.canceledReason) return;
    this.canceledReason = reason;
    if (!this.controller.signal.aborted) {
      this.controller.abort(new DOMException(reason, "AbortError"));
    }
    const waiting = this.waiting.splice(0);
    for (const pending of waiting) {
      const result = this.canceledResult();
      this.completed.push(result);
      pending.resolve(result);
    }
  }

  async drain(): Promise<QueueSummary> {
    let observedCount = -1;
    while (observedCount !== this.promises.length) {
      observedCount = this.promises.length;
      await Promise.allSettled(this.promises);
    }
    return this.toSummary();
  }

  dispose(): void {
    if (this.abortSignal && this.abortListener) {
      this.abortSignal.removeEventListener("abort", this.abortListener);
    }
  }

  private pump(): void {
    if (this.canceledReason) return;
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (!next) continue;
      this.active++;
      void this.processLead(next.lead, this.controller.signal)
        .then((result) => {
          this.completed.push(result);
          next.resolve(result);
        })
        .catch((err) => {
          const reason = err instanceof Error ? err.message : String(err);
          const result = {
            inserted: false,
            reason: `Queued subagent failed: ${reason}`,
            row_summary: undefined,
            clues: undefined,
          };
          this.completed.push(result);
          next.resolve(result);
        })
        .finally(() => {
          this.active--;
          if (!this.canceledReason) this.pump();
        });
    }
  }

  private canceledResult(): InvestigateResult {
    return {
      inserted: false,
      reason: this.canceledReason ?? "Queued subagent canceled",
      row_summary: undefined,
      clues: undefined,
    };
  }

  private toSummary(): QueueSummary {
    const failed = this.completed.filter((result) => !result.inserted).length;
    return {
      completed: this.completed.length,
      inserted: this.completed.filter((result) => result.inserted).length,
      failed,
      pending: this.waiting.length,
      active: this.active,
      reasons: this.completed
        .filter((result) => !result.inserted)
        .map((result) => result.reason)
        .slice(-10),
    };
  }
}

const queuedSubagentsByRun = new Map<string, SubagentQueue>();

export async function drainQueuedSubagents(workflowRunId: string): Promise<QueueSummary> {
  const queue = queuedSubagentsByRun.get(workflowRunId);
  if (!queue) {
    return { completed: 0, inserted: 0, failed: 0, pending: 0, active: 0, reasons: [] };
  }
  try {
    return await queue.drain();
  } finally {
    queue.dispose();
    queuedSubagentsByRun.delete(workflowRunId);
  }
}

export async function clearQueuedSubagents(workflowRunId: string): Promise<QueueSummary> {
  const queue = queuedSubagentsByRun.get(workflowRunId);
  if (!queue) {
    return { completed: 0, inserted: 0, failed: 0, pending: 0, active: 0, reasons: [] };
  }
  queue.cancel("Queued subagents cleared");
  try {
    return await queue.drain();
  } finally {
    queue.dispose();
    queuedSubagentsByRun.delete(workflowRunId);
  }
}

function abortSignalMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  return reason ? String(reason) : "Run was stopped";
}

function throwIfAbortSignalAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException(abortSignalMessage(signal), "AbortError");
}

function isStopped(
  authorizedDatasetId: string,
  abortSignal: AbortSignal | undefined,
): boolean {
  return isDatasetRunAborted(authorizedDatasetId) || abortSignal?.aborted === true;
}

function throwIfStopped(
  authorizedDatasetId: string,
  abortSignal: AbortSignal | undefined,
): void {
  throwIfDatasetRunAborted(authorizedDatasetId);
  throwIfAbortSignalAborted(abortSignal);
}

function parseInvestigateResult(
  text: string,
): z.infer<typeof investigateOutputSchema> {
  const insertedMatch = text.match(/INSERTED:\s*(true|false)/i);
  const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?=\nCLUES:|\nREASON:|$)/is);
  const cluesMatch = text.match(/CLUES:\s*(.+?)(?=\nREASON:|$)/is);
  const reasonMatch = text.match(/REASON:\s*(.+?)$/is);

  return {
    inserted: insertedMatch?.[1]?.toLowerCase() === "true",
    row_summary: summaryMatch?.[1]?.trim() || undefined,
    clues: cluesMatch?.[1]?.trim() || undefined,
    reason: reasonMatch?.[1]?.trim() || text.slice(0, 300),
  };
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function filledColumnNames(
  draft: RowExtractorDraftResult | undefined,
  columns: PopulateColumn[],
): string[] {
  if (!draft?.data) return [];
  const primaryKeyColumns = new Set(
    columns.filter((column) => column.isPrimaryKey).map((column) => column.name),
  );
  return Object.entries(draft.data)
    .filter(([column, value]) => {
      if (!hasMeaningfulValue(value)) return false;
      if (primaryKeyColumns.has(column)) return true;
      return (draft.cellSources?.[column]?.length ?? 0) > 0;
    })
    .map(([column]) => column);
}

function formatRowData(data: Record<string, unknown> | undefined): string {
  if (!data) return "(none)";
  const lines = Object.entries(data)
    .filter(([, value]) => hasMeaningfulValue(value))
    .map(([column, value]) => `- ${column}: ${JSON.stringify(value)}`);
  return lines.length > 0 ? lines.join("\n") : "(none)";
}

function pickRowData(
  data: Record<string, unknown> | undefined,
  columns: string[],
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const picked: Record<string, unknown> = {};
  for (const column of columns) {
    const value = data[column];
    if (hasMeaningfulValue(value)) picked[column] = value;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function formatUnresolvedColumns(
  columns: PopulateColumn[],
  draft: RowExtractorDraftResult | undefined,
  lockedColumns: string[] = [],
): string {
  if (!draft) return "(none)";
  const locked = new Set(lockedColumns);
  const fallbackNames = columns
    .filter((column) => !column.isPrimaryKey)
    .filter((column) => {
      if (locked.has(column.name)) return false;
      return draft.missingColumns?.includes(column.name) || hasMeaningfulValue(draft.data?.[column.name]);
    })
    .map((column) => column.name);
  if (fallbackNames.length === 0) return "(none)";

  const columnByName = new Map(columns.map((column) => [column.name, column]));
  return fallbackNames
    .map((name) => {
      const column = columnByName.get(name);
      const requiredness = column?.nullable === false ? "required" : "optional";
      const status = draft.columnStatuses?.[name];
      const missingCellSource =
        hasMeaningfulValue(draft.data?.[name]) && (draft.cellSources?.[name]?.length ?? 0) === 0;
      const detail = [
        `${requiredness}`,
        missingCellSource ? "browser_status=unverified_cell_source" : undefined,
        status?.status ? `browser_status=${status.status}` : undefined,
        status?.reason ? `reason=${JSON.stringify(status.reason)}` : undefined,
        column?.normalizationHint
          ? `normalization=${JSON.stringify(column.normalizationHint)}`
          : undefined,
      ]
        .filter(Boolean)
        .join("; ");
      return `- ${name} (${detail})`;
    })
    .join("\n");
}

/**
 * Build row-investigation tools scoped to one dataset.
 *
 * `run_subagent` is the original synchronous path. `queue_subagents` lets the
 * orchestrator keep enumerating while row workers build/reuse extractors and
 * investigate queued candidates in the background. The workflow drains the queue
 * before completing, so queued work is still part of the populate run.
 *
 * authorizedDatasetId and authContext are captured by closure — not
 * exposed in the tool schema, never visible to the orchestrator LLM.
 */
export function buildSubagentTools(
  authorizedDatasetId: string,
  authContext: AuthContext,
  columns: PopulateColumn[],
  llmConfig: LlmProviderConfig,
  maxRowCount: number,
  datasetContext: DatasetContextForExtractor,
  metrics?: RunMetrics,
) {
  const throwIfStoppedForLead = (abortSignal?: AbortSignal) =>
    throwIfStopped(authorizedDatasetId, abortSignal);

  const processLead: ProcessLead = async (
    { entity_hint, primary_keys, context, urls, notes },
    leadAbortSignal,
  ): Promise<InvestigateResult> => {
    try {
      throwIfStoppedForLead(leadAbortSignal);
      const rowCount = await convex.query(internal.datasetRows.countByDataset, {
        datasetId: authorizedDatasetId,
      });
      throwIfStoppedForLead(leadAbortSignal);
      if (rowCount >= maxRowCount) {
        return {
          inserted: false,
          reason: `ROW_LIMIT_REACHED: this BigSet dataset is capped at ${maxRowCount} rows. Stop calling run_subagent and finish the run.`,
          row_summary: undefined,
          clues: undefined,
        };
      }

      if (metrics) metrics.investigateCalls++;
      const primaryKeyRecord = Object.fromEntries(
        primary_keys.map(({ column, value }) => [column, value]),
      );

      throwIfStoppedForLead(leadAbortSignal);
      const extractorResult = await tryRowExtractorDraft({
        datasetId: authorizedDatasetId,
        columns,
        primaryKeys: primaryKeyRecord,
        urls,
        context,
        datasetName: datasetContext.datasetName,
        description: datasetContext.description,
        retrievalStrategy: datasetContext.retrievalStrategy,
        sourceHint: datasetContext.sourceHint,
        codificationProfile: datasetContext.codificationProfile,
        browserAttempts: authContext.modelConfig.rowExtractorBrowserAttempts,
        extractorBuilderModel: authContext.modelConfig.extractorBuilder,
        abortSignal: leadAbortSignal,
      });
      throwIfStoppedForLead(leadAbortSignal);
      if (/duplicate/i.test(extractorResult.reason)) {
        return {
          inserted: false,
          reason: extractorResult.reason,
          row_summary: undefined,
          clues: undefined,
        };
      }

      if (extractorResult.status === "extracted") {
        const missingColumns = extractorResult.missingColumns ?? [];
        const primaryKeyIssue = validatePrimaryKeySources(
          extractorResult.data ?? {},
          extractorResult.sources ?? [],
          extractorResult.cellSources,
          columns,
          true,
          datasetContext.sourceHint,
        );
        if (missingColumns.length === 0 && !primaryKeyIssue) {
          try {
            throwIfStoppedForLead(leadAbortSignal);
            await convex.mutation(internal.datasetRows.insert, {
              datasetId: authorizedDatasetId,
              data: extractorResult.data ?? {},
              sources: extractorResult.sources,
              cellSources: extractorResult.cellSources,
              rowSummary: extractorResult.rowSummary,
              howFound:
                "Opened the row target with TinyFish Browser and ran the dataset's generated Playwright extractor. No fallback columns were unresolved.",
            });
            if (metrics) metrics.rowsInserted++;
            console.log(
              `[run_subagent] row extractor inserted complete row entity="${entity_hint}" reason="${extractorResult.reason}"`,
            );
            return {
              inserted: true,
              reason: extractorResult.reason,
              row_summary: extractorResult.rowSummary,
              clues: undefined,
            };
          } catch (err) {
            if (isAbortLikeError(err) && isStopped(authorizedDatasetId, leadAbortSignal)) {
              throw err;
            }
            const msg = err instanceof Error ? err.message : String(err);
            if (/duplicate/i.test(msg)) {
              return {
                inserted: false,
                reason: `${msg} Move on to the next entity.`,
                row_summary: undefined,
                clues: undefined,
              };
            }
            throw err;
          }
        }

        if (primaryKeyIssue) {
          console.warn(
            `[run_subagent] row extractor primary-key evidence insufficient entity="${entity_hint}" reason="${primaryKeyIssue}"`,
          );
        } else {
          console.log(
            `[run_subagent] row extractor drafted entity="${entity_hint}" filled=${extractorResult.extractedColumns?.length ?? 0} unresolved=${missingColumns.length}`,
          );
        }
      } else if (extractorResult.status === "failed") {
        console.warn(
          `[run_subagent] row extractor failed entity="${entity_hint}" reason="${extractorResult.reason}"`,
        );
      } else if (extractorResult.status === "miss") {
        console.log(
          `[run_subagent] row extractor missed entity="${entity_hint}" reason="${extractorResult.reason}"`,
        );
      }

      throwIfStoppedForLead(leadAbortSignal);
      console.log(
        `[run_subagent] spawning subagent user=${authContext.authorizedUserId} run=${authContext.workflowRunId} dataset=${authorizedDatasetId} entity="${entity_hint}" pk=${JSON.stringify(primary_keys)}`,
      );

      const browserFilledValues =
        extractorResult.status === "extracted" ? extractorResult.data : undefined;
      const browserFilledColumns =
        extractorResult.status === "extracted"
          ? filledColumnNames(extractorResult, columns)
          : [];
      const browserCandidateValues =
        extractorResult.status === "extracted"
          ? pickRowData(browserFilledValues, browserFilledColumns)
          : undefined;
      const browserSources =
        extractorResult.status === "extracted" ? extractorResult.sources : undefined;

      const agent = buildInvestigateAgent(
        authorizedDatasetId,
        authContext,
        columns,
        llmConfig,
        {
          membershipSourceHint: datasetContext.sourceHint,
          abortSignal: leadAbortSignal,
        },
      );

      const pkBlock = primary_keys
        .map(({ column, value }) => `- ${column}: ${value}`)
        .join("\n");
      const urlsBlock =
        urls && urls.length > 0
          ? `\nUseful URLs to start from:\n${urls.map((u) => `- ${u}`).join("\n")}`
          : "";
      const notesBlock = notes ? `\nAdditional notes: ${notes}` : "";
      const browserDraftBlock =
        extractorResult.status === "extracted"
          ? `

Browser extraction produced these candidate values, but this row still needs fallback verification. Treat them as hints, not locked facts. Re-verify all primary key values and any non-empty candidate before insert_row. If a URL primary key 404s, redirects to a different entity, or cannot be justified by source-backed evidence, do not insert the row:
${formatRowData(browserCandidateValues)}

Unresolved columns to research now. Try every listed column, including optional ones. If a value still cannot be verified, insert "" for that column and explain why:
${formatUnresolvedColumns(columns, extractorResult, browserFilledColumns)}

Browser sources already used:
${(browserSources ?? []).map((u) => `- ${u}`).join("\n") || "(none)"}
`
          : `

Browser extraction did not produce a usable draft for this row:
- status: ${extractorResult.status}
- reason: ${extractorResult.reason}

Research all non-primary columns normally.`;

      const prompt = `Research this entity and insert a row if you find real, verified data.

Entity: ${entity_hint}

Primary key values (MUST be included in insert_row):
${pkBlock}

Context (partial data already found):
${context}${urlsBlock}${notesBlock}${browserDraftBlock}`;

      const agentAbortSignal = leadAbortSignal ?? getSignal(authorizedDatasetId);
      throwIfStoppedForLead(leadAbortSignal);
      const result = await agent.generate(prompt, {
        abortSignal: agentAbortSignal,
        maxSteps: 25,
        modelSettings: {
          maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS.INVESTIGATE_SUBAGENT,
        },
      });
      if (metrics) {
        // Use result.toolCalls (the flat accumulated list across all steps) rather
        // than iterating result.steps[n].toolCalls. The per-step arrays are snapshots
        // captured at step-finish time; tool-call chunks that arrive after their
        // step-finish event end up attributed to the wrong step, causing systematic
        // miscounts. result.toolCalls is the authoritative list maintained by Mastra's
        // stream processor as chunks arrive.
        metrics.countToolCalls(result.toolCalls ?? []);
        metrics.addInvestigateResult(result);
      }

      const parsed = parseInvestigateResult(result.text);
      if (metrics && parsed.inserted) metrics.rowsInserted++;

      console.log(
        `[run_subagent] done entity="${entity_hint}" inserted=${parsed.inserted} steps=${result.steps?.length ?? "?"} toolCalls=${result.toolCalls?.length ?? "?"}` +
          (parsed.row_summary ? `\n  summary: ${parsed.row_summary}` : "") +
          (parsed.reason ? `\n  reason:  ${parsed.reason}` : "") +
          (parsed.clues ? `\n  clues:   ${parsed.clues}` : ""),
      );
      return parsed;
    } catch (err) {
      // Only propagate an AbortError if OUR signal was actually fired (i.e.
      // the user pressed Stop). Network errors in Node.js can also surface as
      // AbortError — re-throwing those would cause the orchestrator's
      // agent.generate() to exit early and return a graceful empty result,
      // producing a "0 rows" run without any user action.
      if (isAbortLikeError(err) && isStopped(authorizedDatasetId, leadAbortSignal)) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[run_subagent] subagent error entity="${entity_hint}" err=${msg}`);
      return {
        inserted: false,
        reason: `Subagent failed: ${msg}`,
        row_summary: undefined,
        clues: undefined,
      };
    }
  };

  const queue = new SubagentQueue(
    Math.min(20, Math.max(1, authContext.modelConfig.rowExtractorConcurrency)),
    processLead,
    getSignal(authorizedDatasetId),
  );
  queuedSubagentsByRun.set(authContext.workflowRunId, queue);

  const runSubagentTool = createTool({
    id: "run_subagent",
    description:
      "Hand off a lead to a subagent that will research it deeply and insert a single row if it finds real, verified data. You MUST pass the primary key values (primary_keys) for the entity — the subagent will fill in the remaining columns. Also pass any URLs and context you have found.",
    inputSchema: investigateInputSchema,
    outputSchema: investigateOutputSchema,
    execute: async (lead) => processLead(lead),
  });

  const queueSubagentsTool = createTool({
    id: "queue_subagents",
    description:
      "Queue a batch of candidate rows for background investigation. Use this when you have multiple leads so enumeration can continue while extractor builds and row research run in parallel. The workflow drains queued work before finishing.",
    inputSchema: queueSubagentsInputSchema,
    outputSchema: queueSubagentsOutputSchema,
    execute: async ({ candidates }) => {
      throwIfStoppedForLead();
      queue.enqueueMany(candidates);
      const summary = queue.snapshot();
      console.log(
        `[queue_subagents] user=${authContext.authorizedUserId} run=${authContext.workflowRunId} dataset=${authorizedDatasetId} queued=${candidates.length} pending=${summary.pending} active=${summary.active} completed=${summary.completed}`,
      );
      return {
        queued: candidates.length,
        pending: summary.pending,
        active: summary.active,
        completed: summary.completed,
        reason:
          "Queued. Continue enumerating more candidates; call drain_subagents only when you need feedback or before finishing.",
      };
    },
  });

  const drainSubagentsTool = createTool({
    id: "drain_subagents",
    description:
      "Wait for queued candidate investigations to finish and return a summary. Use this when you need feedback from queued rows or before you finish.",
    inputSchema: z.object({}),
    outputSchema: drainSubagentsOutputSchema,
    execute: async () => {
      if (isDatasetRunAborted(authorizedDatasetId)) {
        queue.cancel("Run was stopped");
      }
      const summary = await queue.drain();
      console.log(
        `[drain_subagents] user=${authContext.authorizedUserId} run=${authContext.workflowRunId} dataset=${authorizedDatasetId} completed=${summary.completed} inserted=${summary.inserted} failed=${summary.failed}`,
      );
      return summary;
    },
  });

  return {
    run_subagent: runSubagentTool,
    queue_subagents: queueSubagentsTool,
    drain_subagents: drainSubagentsTool,
  };
}
