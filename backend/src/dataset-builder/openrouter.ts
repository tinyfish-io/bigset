import type {
  AgentHarnessStage,
  ClarifyingQuestion,
  DatasetBuildPlan,
  DatasetBuildRequest,
  DatasetColumnDefinition,
  DatasetSchema,
  DatasetSourceStrategy,
  DatasetUpdateCadence,
} from "./types.js";

interface OpenRouterChoice {
  message?: {
    content?: string;
  };
}

interface OpenRouterChatResponse {
  choices?: OpenRouterChoice[];
}

interface OpenRouterPlannerConfig {
  apiKey: string;
  model: string;
}

export class OpenRouterPlannerClient {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: OpenRouterPlannerConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  async refineDatasetBuildPlan(
    request: DatasetBuildRequest,
    draftPlan: DatasetBuildPlan
  ): Promise<DatasetBuildPlan> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 30_000);

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/tinyfish-io/bigset",
          "X-Title": "BigSet Dataset Builder",
        },
        signal: abortController.signal,
        body: JSON.stringify({
          model: this.model,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You design reliable web-data agent harnesses. Return only JSON. Preserve the input shape exactly. Never invent user-provided facts.",
            },
            {
              role: "user",
              content: JSON.stringify({
                task:
                  "Refine this BigSet dataset build plan. Improve schema, clarifying questions, source strategy, validation rules, and next actions.",
                request,
                draftPlan,
              }),
            },
          ],
        }),
      }
    ).finally(() => {
      clearTimeout(timeout);
    });

    if (!response.ok) {
      throw new Error(`OpenRouter returned ${response.status}`);
    }

    const payload = (await response.json()) as OpenRouterChatResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenRouter returned no message content.");
    }

    return normalizeOpenRouterPlan(content, draftPlan);
  }
}

export function createOpenRouterPlannerClient(config: {
  apiKey?: string;
  model: string;
}): OpenRouterPlannerClient | undefined {
  if (!config.apiKey) {
    return undefined;
  }

  return new OpenRouterPlannerClient({
    apiKey: config.apiKey,
    model: config.model,
  });
}

function normalizeOpenRouterPlan(
  rawContent: string,
  fallbackPlan: DatasetBuildPlan
): DatasetBuildPlan {
  const parsedPlan = JSON.parse(extractJsonObject(rawContent)) as Record<
    string,
    unknown
  >;

  const schema = normalizeSchema(parsedPlan.schema, fallbackPlan.schema);
  if (!schema.columns.length) {
    throw new Error("OpenRouter plan did not include schema columns.");
  }

  return {
    ...fallbackPlan,
    datasetName: stringValue(parsedPlan.datasetName) ?? fallbackPlan.datasetName,
    userRequest: fallbackPlan.userRequest,
    updateCadence:
      updateCadenceValue(parsedPlan.updateCadence) ?? fallbackPlan.updateCadence,
    schema,
    sourceStrategy:
      sourceStrategyValue(parsedPlan.sourceStrategy) ??
      fallbackPlan.sourceStrategy,
    clarifyingQuestions: normalizeClarifyingQuestions(
      parsedPlan.clarifyingQuestions,
      fallbackPlan.clarifyingQuestions
    ),
    harnessStages: normalizeHarnessStages(
      parsedPlan.harnessStages,
      fallbackPlan.harnessStages
    ),
    validationRules:
      stringArrayValue(parsedPlan.validationRules) ??
      fallbackPlan.validationRules,
    replacementPolicy:
      stringValue(parsedPlan.replacementPolicy) ??
      fallbackPlan.replacementPolicy,
    nextActions:
      stringArrayValue(parsedPlan.nextActions) ?? fallbackPlan.nextActions,
    plannerWarnings: [
      ...fallbackPlan.plannerWarnings,
      ...((stringArrayValue(parsedPlan.plannerWarnings) ?? []).filter(Boolean)),
    ],
    createdAt: fallbackPlan.createdAt,
  };
}

function extractJsonObject(content: string): string {
  const firstBraceIndex = content.indexOf("{");
  const lastBraceIndex = content.lastIndexOf("}");

  if (firstBraceIndex === -1 || lastBraceIndex === -1 || lastBraceIndex <= firstBraceIndex) {
    throw new Error("OpenRouter response did not contain a JSON object.");
  }

  return content.slice(firstBraceIndex, lastBraceIndex + 1);
}

function normalizeSchema(value: unknown, fallback: DatasetSchema): DatasetSchema {
  if (!isRecord(value)) {
    return fallback;
  }

  const columns = arrayValue(value.columns)
    ?.map(normalizeColumn)
    .filter((column): column is DatasetColumnDefinition => Boolean(column));

  if (!columns?.length) {
    return fallback;
  }

  const identityColumnName =
    stringValue(value.identityColumnName) ??
    columns.find((column) => column.isIdentity)?.name ??
    columns[0]?.name ??
    fallback.identityColumnName;

  return {
    datasetName: stringValue(value.datasetName) ?? fallback.datasetName,
    identityColumnName,
    columns,
  };
}

function normalizeColumn(value: unknown): DatasetColumnDefinition | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = stringValue(value.name);
  const kind = columnKindValue(value.kind);
  const description = stringValue(value.description);

  if (!name || !kind || !description) {
    return null;
  }

  return {
    name,
    kind,
    description,
    isRequired: value.isRequired === true,
    isIdentity: value.isIdentity === true,
    sourceHint: stringValue(value.sourceHint),
  };
}

function normalizeClarifyingQuestions(
  value: unknown,
  fallback: ClarifyingQuestion[]
): ClarifyingQuestion[] {
  const questions = arrayValue(value);
  if (!questions) {
    return fallback;
  }

  return questions
    .map((question, index) => {
      if (typeof question === "string") {
        return {
          id: `openrouter_question_${index + 1}`,
          question,
          reason: "OpenRouter suggested this scope check.",
        };
      }

      if (!isRecord(question)) {
        return null;
      }

      const questionText = stringValue(question.question);
      if (!questionText) {
        return null;
      }

      return {
        id: stringValue(question.id) ?? `openrouter_question_${index + 1}`,
        question: questionText,
        reason:
          stringValue(question.reason) ??
          "OpenRouter suggested this scope check.",
        appliesTo: stringValue(question.appliesTo),
      };
    })
    .filter((question): question is ClarifyingQuestion => Boolean(question));
}

function normalizeHarnessStages(
  value: unknown,
  fallback: AgentHarnessStage[]
): AgentHarnessStage[] {
  const stages = arrayValue(value);
  if (!stages) {
    return fallback;
  }

  const normalizedStages = stages
    .map((stage) => {
      if (!isRecord(stage)) {
        return null;
      }

      const id = stringValue(stage.id);
      const title = stringValue(stage.title);
      const purpose = stringValue(stage.purpose);
      const tool = harnessToolValue(stage.tool);

      if (!id || !title || !purpose || !tool) {
        return null;
      }

      return {
        id,
        title,
        purpose,
        tool,
        canRunWithoutUser: stage.canRunWithoutUser === true,
      };
    })
    .filter((stage): stage is AgentHarnessStage => Boolean(stage));

  return normalizedStages.length > 0 ? normalizedStages : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
}

function columnKindValue(value: unknown): DatasetColumnDefinition["kind"] | undefined {
  if (
    value === "text" ||
    value === "number" ||
    value === "boolean" ||
    value === "date" ||
    value === "url" ||
    value === "json"
  ) {
    return value;
  }

  return undefined;
}

function updateCadenceValue(value: unknown): DatasetUpdateCadence | undefined {
  if (
    value === "manual" ||
    value === "hourly" ||
    value === "daily" ||
    value === "weekly"
  ) {
    return value;
  }

  return undefined;
}

function sourceStrategyValue(value: unknown): DatasetSourceStrategy | undefined {
  if (
    value === "search_fetch" ||
    value === "search_fetch_browser" ||
    value === "browser_form_fill"
  ) {
    return value;
  }

  return undefined;
}

function harnessToolValue(value: unknown): AgentHarnessStage["tool"] | undefined {
  if (
    value === "user_input" ||
    value === "tinyfish_search" ||
    value === "tinyfish_fetch" ||
    value === "tinyfish_agent" ||
    value === "validator" ||
    value === "database"
  ) {
    return value;
  }

  return undefined;
}
