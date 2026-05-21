import { Output, ToolLoopAgent, stepCountIs, tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";

import {
  emptyMetrics,
  emptyUsage,
  minimumRequiredColumnsForRunInput,
  normalizeDatasetAgentResult,
  parseOutputFromText,
} from "./output.js";
import type {
  DatasetAgentMetrics,
  DatasetAgentRunResult,
  DatasetAgentRunInput,
  DatasetAgentRuntime,
  DatasetAgentToolProvider,
  DatasetAgentUsage,
} from "./types.js";

const MAX_FETCH_URLS_PER_TOOL_CALL = 8;
const MAX_PAGE_TEXT_CHARS = 8_000;

const evidenceSchema = z.object({
  columnName: z.string(),
  sourceUrl: z.string(),
  quote: z.string(),
});

const rowSchema = z.object({
  cells: z.record(z.string(), z.unknown()),
  sourceUrls: z.array(z.string()),
  evidence: z.array(evidenceSchema),
  needsReview: z.boolean().default(false),
});

const datasetAgentOutputSchema = z.object({
  rows: z.array(rowSchema),
  validationIssues: z.array(z.string()).default([]),
});

interface AiSdkUsageLike {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface AiSdkGenerateResultLike {
  output?: unknown;
  text?: string;
  usage?: AiSdkUsageLike;
  steps?: unknown[];
}

interface AiSdkAgentLike {
  generate(input: { prompt: string }): Promise<AiSdkGenerateResultLike>;
}

export type DatasetAgentAiSdkModel = LanguageModel | string;

interface CreateAiSdkAgentInput {
  model: DatasetAgentAiSdkModel;
  instructions: string;
  tools: ToolSet;
  maxSteps: number;
  onStepFinish: (event: { usage?: AiSdkUsageLike }) => void;
}

type AiSdkAgentFactory = (input: CreateAiSdkAgentInput) => AiSdkAgentLike;

export class AiSdkDatasetAgentRuntime implements DatasetAgentRuntime {
  private readonly model: DatasetAgentAiSdkModel;
  private readonly maxSteps: number;
  private readonly maxRepairAttempts: number;
  private readonly toolProvider: DatasetAgentToolProvider;
  private readonly createAgent: AiSdkAgentFactory;

  constructor(input: {
    model: DatasetAgentAiSdkModel;
    toolProvider: DatasetAgentToolProvider;
    maxSteps?: number;
    maxRepairAttempts?: number;
    createAgent?: AiSdkAgentFactory;
  }) {
    this.model = input.model;
    this.maxSteps = input.maxSteps ?? 8;
    this.maxRepairAttempts = input.maxRepairAttempts ?? 1;
    this.toolProvider = input.toolProvider;
    this.createAgent = input.createAgent ?? createToolLoopAgent;
  }

  async runDatasetBuild(input: DatasetAgentRunInput) {
    const usage = emptyUsage();
    const metrics = emptyMetrics();
    const agent = this.createAgent({
      model: this.model,
      instructions: createInstructions(input),
      tools: createTools({
        toolProvider: this.toolProvider,
        metrics,
      }),
      maxSteps: this.maxSteps,
      onStepFinish: (event) => {
        metrics.agentSteps += 1;
        addUsage(usage, event.usage);
      },
    });

    const firstGeneration = await generateWithTelemetry({
      agent,
      prompt: createPrompt(input),
      usage,
      metrics,
    });
    const firstResult = normalizeGenerationResult({
      generation: firstGeneration,
      runInput: input,
      usage,
      metrics,
    });

    if (
      firstResult.validationIssues.length === 0 ||
      this.maxRepairAttempts === 0
    ) {
      return firstResult;
    }

    const repairGeneration = await generateWithTelemetry({
      agent,
      prompt: createRepairPrompt({
        input,
        invalidOutput: generationRawOutput(firstGeneration),
        validationIssues: firstResult.validationIssues,
      }),
      usage,
      metrics,
    });
    const repairedResult = normalizeGenerationResult({
      generation: repairGeneration,
      runInput: input,
      usage,
      metrics,
    });

    if (isRepairResultBetter({ firstResult, repairedResult })) {
      return repairedResult;
    }

    return {
      ...firstResult,
      usage: { ...usage },
      metrics: { ...metrics },
    };
  }
}

function isRepairResultBetter(input: {
  firstResult: DatasetAgentRunResult;
  repairedResult: DatasetAgentRunResult;
}): boolean {
  if (
    input.firstResult.rows.length > 0 &&
    input.repairedResult.rows.length === 0
  ) {
    return false;
  }

  if (
    input.repairedResult.validationIssues.length === 0 &&
    input.firstResult.validationIssues.length > 0
  ) {
    return true;
  }

  return (
    resultUsefulnessScore(input.repairedResult) >
    resultUsefulnessScore(input.firstResult)
  );
}

function resultUsefulnessScore(result: DatasetAgentRunResult): number {
  const nonEmptyCellCount = result.rows.reduce(
    (total, row) =>
      total +
      Object.values(row.cells).filter((cellValue) => isUsefulCell(cellValue))
        .length,
    0
  );
  const sourceUrlCount = result.rows.reduce(
    (total, row) => total + row.sourceUrls.length,
    0
  );
  const evidenceQuoteCount = result.rows.reduce(
    (total, row) => total + row.evidence.length,
    0
  );

  return (
    result.rows.length * 4 +
    nonEmptyCellCount * 2 +
    sourceUrlCount +
    evidenceQuoteCount -
    result.validationIssues.length * 3
  );
}

function isUsefulCell(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

async function generateWithTelemetry(input: {
  agent: AiSdkAgentLike;
  prompt: string;
  usage: DatasetAgentUsage;
  metrics: DatasetAgentMetrics;
}): Promise<AiSdkGenerateResultLike> {
  input.metrics.agentRuns += 1;
  const generation = await input.agent.generate({ prompt: input.prompt });
  addUsage(input.usage, generation.usage);
  if (generation.steps?.length) {
    input.metrics.agentSteps = Math.max(
      input.metrics.agentSteps,
      generation.steps.length
    );
  }
  return generation;
}

function normalizeGenerationResult(input: {
  generation: AiSdkGenerateResultLike;
  runInput: DatasetAgentRunInput;
  usage: DatasetAgentUsage;
  metrics: DatasetAgentMetrics;
}) {
  return normalizeDatasetAgentResult({
    rawOutput: generationRawOutput(input.generation),
    runInput: input.runInput,
    usage: input.usage,
    metrics: input.metrics,
  });
}

function generationRawOutput(generation: AiSdkGenerateResultLike): unknown {
  const outputField = readGenerationField(generation, "output");
  if (
    outputField.ok &&
    outputField.value !== undefined &&
    outputField.value !== null
  ) {
    return outputField.value;
  }

  const textField = readGenerationField(generation, "text");
  if (textField.ok && typeof textField.value === "string") {
    return parseOutputFromText(textField.value);
  }

  return {
    rows: [],
    validationIssues: [
      outputField.ok
        ? "AI SDK generated no structured output."
        : `AI SDK structured output unavailable: ${errorMessage(outputField.error)}`,
    ],
  };
}

function readGenerationField<FieldName extends keyof AiSdkGenerateResultLike>(
  generation: AiSdkGenerateResultLike,
  fieldName: FieldName
):
  | { ok: true; value: AiSdkGenerateResultLike[FieldName] }
  | { ok: false; error: unknown } {
  try {
    return { ok: true, value: generation[fieldName] };
  } catch (error) {
    return { ok: false, error };
  }
}

function createToolLoopAgent(input: CreateAiSdkAgentInput): AiSdkAgentLike {
  return new ToolLoopAgent({
    model: input.model,
    temperature: 0,
    maxOutputTokens: 3_000,
    instructions: input.instructions,
    tools: input.tools,
    output: Output.object({ schema: datasetAgentOutputSchema }),
    stopWhen: stepCountIs(input.maxSteps),
    onStepFinish: input.onStepFinish,
  }) as unknown as AiSdkAgentLike;
}

function createInstructions(input: DatasetAgentRunInput): string {
  const minimumRequiredColumns = minimumRequiredColumnsForRunInput(input);

  return [
    "You are BigSet's dataset collection agent.",
    "Build source-backed rows from web data. Never guess missing facts.",
    "Use search first, fetch source pages next, and browser automation only when fetch cannot verify the requested value.",
    "Every row must include cells, sourceUrls, and evidence quotes copied from source text or browser output.",
    "Put the actual extracted values in cells. Evidence supports cells; evidence does not replace cells.",
    "For named entities in the user request, return one row per entity when an official source can back the identity and at least one requested value.",
    "Do not return zero rows after fetching official sources. Return partial source-backed rows with needsReview true when optional requested values are incomplete.",
    "Once enough official evidence is found for the requested entities, stop searching and return the rows.",
    "Set needsReview true when the source is weak, ambiguous, stale, or incomplete.",
    `Requested columns: ${input.requiredColumns.join(", ")}`,
    `Minimum required columns for accepting a row: ${minimumRequiredColumns.join(", ") || "none"}`,
    "Missing requested columns outside the minimum should be null or omitted, not invented.",
  ].join("\n");
}

function createPrompt(input: DatasetAgentRunInput): string {
  const minimumRequiredColumns = minimumRequiredColumnsForRunInput(input);

  return JSON.stringify({
    promptId: input.promptId,
    promptQuality: input.promptQuality,
    userRequest: input.prompt,
    requestedColumns: input.requiredColumns,
    minimumRequiredColumns,
    outputShape: {
      rows:
        "Array of rows with cells keyed by requested column when source-backed. cells must contain the extracted values; sourceUrls and evidence prove them.",
      validationIssues:
        "Concrete validation problems. Empty only when all rows are source-backed.",
    },
  });
}

function createRepairPrompt(input: {
  input: DatasetAgentRunInput;
  invalidOutput: unknown;
  validationIssues: string[];
}): string {
  const minimumRequiredColumns = minimumRequiredColumnsForRunInput(input.input);

  return JSON.stringify({
    task: "Repair the previous dataset-agent output. Use tools again if needed. Return only valid source-backed rows.",
    userRequest: input.input.prompt,
    requestedColumns: input.input.requiredColumns,
    minimumRequiredColumns,
    validationIssues: input.validationIssues,
    invalidOutput: input.invalidOutput,
    repairRules: [
      "Do not invent values.",
      "Every row needs at least one source URL.",
      "Every row needs at least one evidence quote.",
      "Every source-backed value must be written into cells under the matching requested column.",
      "Every minimum required column must be present or the row should be omitted.",
      "Requested columns outside the minimum can be null or missing when the source does not prove them.",
      "If source-backed rows cannot be produced, return rows: [] and validationIssues explaining why.",
    ],
  });
}

function createTools(input: {
  toolProvider: DatasetAgentToolProvider;
  metrics: DatasetAgentMetrics;
}): ToolSet {
  return {
    searchWeb: tool({
      description:
        "Search web pages likely to contain source-backed dataset rows.",
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: async ({ query }) => {
        input.metrics.searchCalls += 1;
        return input.toolProvider.search({ query });
      },
    }),
    fetchPages: tool({
      description:
        "Fetch markdown text from source URLs before using browser automation.",
      inputSchema: z.object({
        urls: z.array(z.string()).max(MAX_FETCH_URLS_PER_TOOL_CALL),
      }),
      execute: async ({ urls }) => {
        input.metrics.fetchCalls += 1;
        const pages = await input.toolProvider.fetch({ urls });
        return pages.map((page) => ({
          ...page,
          text: page.text?.slice(0, MAX_PAGE_TEXT_CHARS) ?? null,
        }));
      },
    }),
    verifyWithBrowser: tool({
      description:
        "Use TinyFish Agent/browser when source values require clicking, forms, menus, or dynamic pages.",
      inputSchema: z.object({
        url: z.string(),
        goal: z.string(),
      }),
      execute: async ({ url, goal }) => {
        input.metrics.browserCalls += 1;
        const result = await input.toolProvider.browser({ url, goal });
        input.metrics.agentSteps += result.stepCount ?? 0;
        return result;
      },
    }),
  };
}

function addUsage(target: DatasetAgentUsage, usage?: AiSdkUsageLike) {
  if (!usage) {
    return;
  }

  const promptTokens = numericValue(
    usage.promptTokens ?? usage.inputTokens
  );
  const completionTokens = numericValue(
    usage.completionTokens ?? usage.outputTokens
  );
  target.promptTokens += promptTokens;
  target.completionTokens += completionTokens;
  target.totalTokens +=
    numericValue(usage.totalTokens) || promptTokens + completionTokens;
}

function numericValue(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
