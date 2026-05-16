import { createHarnessStages } from "./agent-harness.js";
import type { OpenRouterPlannerClient } from "./openrouter.js";
import type {
  ClarifyingQuestion,
  DatasetBuildPlan,
  DatasetBuildRequest,
  DatasetColumnDefinition,
  DatasetSourceStrategy,
  DatasetUpdateCadence,
} from "./types.js";

interface PlannerOptions {
  openRouterClient?: OpenRouterPlannerClient;
}

export async function createDatasetBuildPlan(
  request: DatasetBuildRequest,
  options: PlannerOptions = {}
): Promise<DatasetBuildPlan> {
  const draftPlan = createDeterministicDatasetBuildPlan(request);

  if (request.planningMode === "openrouter" && options.openRouterClient) {
    try {
      return await options.openRouterClient.refineDatasetBuildPlan(
        request,
        draftPlan
      );
    } catch (error) {
      return {
        ...draftPlan,
        plannerWarnings: [
          ...draftPlan.plannerWarnings,
          error instanceof Error
            ? `OpenRouter planner failed: ${error.message}`
            : "OpenRouter planner failed with an unknown error.",
        ],
      };
    }
  }

  if (request.planningMode === "openrouter" && !options.openRouterClient) {
    return {
      ...draftPlan,
      plannerWarnings: [
        ...draftPlan.plannerWarnings,
        "OpenRouter planner was requested but no API key is loaded; using deterministic fallback.",
      ],
    };
  }

  return draftPlan;
}

function createDeterministicDatasetBuildPlan(
  request: DatasetBuildRequest
): DatasetBuildPlan {
  const normalizedRequest = request.userRequest.trim();
  const lowerRequest = normalizedRequest.toLowerCase();
  const preferredColumns = request.preferredColumns ?? [];
  const clarifyingQuestions = inferClarifyingQuestions(
    lowerRequest,
    request.providedInputs ?? {}
  );
  const sourceStrategy = inferSourceStrategy(lowerRequest);
  const datasetName = inferDatasetName(normalizedRequest);
  const columns = mergeColumns(
    inferColumns(lowerRequest),
    preferredColumns.map((columnName) => ({
      name: normalizeColumnName(columnName),
      kind: "text" as const,
      description: `User-requested field: ${columnName}`,
      isRequired: false,
    }))
  );

  const schema = {
    datasetName,
    identityColumnName: columns[0]?.name ?? "entity_name",
    columns,
  };

  return {
    datasetName,
    userRequest: normalizedRequest,
    updateCadence: request.updateCadence ?? "manual",
    schema,
    sourceStrategy,
    clarifyingQuestions,
    harnessStages: createHarnessStages(
      sourceStrategy,
      clarifyingQuestions.length > 0
    ),
    validationRules: [
      "Every populated value must include a source URL.",
      "Rows missing the identity column are rejected.",
      "Cells that cannot be found are stored as null with status missing.",
      "LLM-generated values are not accepted unless backed by fetched or browsed source text.",
      "Scheduled updates replace cells for the same identity row instead of appending duplicates.",
    ],
    replacementPolicy:
      "Use the identity column to upsert the current row. Keep run artifacts separately so history can be added later without changing the MVP table contract.",
    nextActions: [
      "Confirm or answer any clarifying questions before browser/form work.",
      "Run TinyFish Search to discover candidate source URLs.",
      "Run TinyFish Fetch on candidate URLs and fill easy fields first.",
      "Escalate only hard-to-reach values to TinyFish Agent/browser automation.",
      "Validate shape, source URLs, and missing cells before writing rows.",
    ],
    plannerWarnings: [],
    createdAt: new Date().toISOString(),
  };
}

function inferColumns(lowerRequest: string): DatasetColumnDefinition[] {
  const columns: DatasetColumnDefinition[] = [
    {
      name: "entity_name",
      kind: "text",
      description: "Primary row identity, such as company, product, restaurant, or provider name.",
      isRequired: true,
      isIdentity: true,
    },
    {
      name: "source_url",
      kind: "url",
      description: "URL where the row or latest value was found.",
      isRequired: true,
    },
    {
      name: "last_checked_at",
      kind: "date",
      description: "Timestamp for the latest successful check.",
      isRequired: true,
    },
    {
      name: "confidence_score",
      kind: "number",
      description: "Simple 0-1 confidence score based on source quality and schema match.",
      isRequired: true,
    },
    {
      name: "extraction_status",
      kind: "text",
      description: "valid, missing, or needs_review for the row.",
      isRequired: true,
    },
  ];

  if (/\b(price|prices|pricing|quote|quotes|cost|costs|rate|rates|premium|premiums)\b/.test(lowerRequest)) {
    columns.splice(1, 0, {
      name: "current_price",
      kind: "number",
      description: "Latest price, quote, rate, or premium found for this row.",
      isRequired: false,
      sourceHint: "Usually requires fetch; may require browser form fill for quotes.",
    });
  }

  if (/\b(hiring|jobs|open roles|recruiting)\b/.test(lowerRequest)) {
    columns.splice(1, 0, {
      name: "is_hiring",
      kind: "boolean",
      description: "Whether the source currently shows active hiring.",
      isRequired: false,
    });
    columns.splice(2, 0, {
      name: "open_roles_count",
      kind: "number",
      description: "Count of open roles found on the source.",
      isRequired: false,
    });
  }

  if (/\b(blog|post|article|newsletter)\b/.test(lowerRequest)) {
    columns.splice(1, 0, {
      name: "latest_post_title",
      kind: "text",
      description: "Most recent post title found for this source.",
      isRequired: false,
    });
    columns.splice(2, 0, {
      name: "latest_post_date",
      kind: "date",
      description: "Publication date for the latest post.",
      isRequired: false,
    });
  }

  if (/\b(restaurant|serve|coke|pepsi|menu)\b/.test(lowerRequest)) {
    columns.splice(1, 0, {
      name: "serves_requested_item",
      kind: "boolean",
      description: "Whether the restaurant appears to serve the requested item or brand.",
      isRequired: false,
    });
  }

  return columns;
}

function inferClarifyingQuestions(
  lowerRequest: string,
  providedInputs: Record<string, string>
): ClarifyingQuestion[] {
  const questions: ClarifyingQuestion[] = [];
  const hasLocation = Boolean(providedInputs.location) || /\bin\b\s+[\w\s]+/.test(lowerRequest);

  if (!hasLocation && /\b(restaurant|store|insurance|quote|price)\b/.test(lowerRequest)) {
    questions.push({
      id: "location",
      question: "Which city, state, or region should this dataset target?",
      reason: "Local prices, restaurants, and insurance quotes need geography.",
    });
  }

  if (/\b(insurance|quote|quotes|premium|premiums)\b/.test(lowerRequest)) {
    if (!providedInputs.age) {
      questions.push({
        id: "driver_age",
        question: "What driver age should the quote flow use?",
        reason: "Insurance forms commonly require age before returning a quote.",
      });
    }
    if (!providedInputs.vehicle && !hasVehicleDescription(lowerRequest)) {
      questions.push({
        id: "vehicle",
        question: "What vehicle make, model, and year should the quote flow use?",
        reason: "Vehicle details change quote eligibility and price.",
      });
    }
  }

  if (/\b(competitor|competitors)\b/.test(lowerRequest) && !providedInputs.competitors) {
    questions.push({
      id: "competitor_list",
      question: "Which competitor names or domains should seed the search?",
      reason: "Without seed competitors, the agent may build rows for the wrong market.",
    });
  }

  return questions;
}

function inferSourceStrategy(lowerRequest: string): DatasetSourceStrategy {
  if (/\b(insurance|quote|quotes|form|application|checkout|booking)\b/.test(lowerRequest)) {
    return "browser_form_fill";
  }
  if (/\b(click|login|filter|map|menu|availability)\b/.test(lowerRequest)) {
    return "search_fetch_browser";
  }
  return "search_fetch";
}

function hasVehicleDescription(lowerRequest: string): boolean {
  return /\b(19|20)\d{2}\s+[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*){1,3}\b/.test(
    lowerRequest
  );
}

function inferDatasetName(userRequest: string): string {
  const cleanedWords = userRequest
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);

  if (cleanedWords.length === 0) {
    return "Untitled Dataset";
  }

  return cleanedWords
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeColumnName(columnName: string): string {
  return columnName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function mergeColumns(
  inferredColumns: DatasetColumnDefinition[],
  preferredColumns: DatasetColumnDefinition[]
): DatasetColumnDefinition[] {
  const seenColumnNames = new Set<string>();
  const columns: DatasetColumnDefinition[] = [];

  for (const column of [...inferredColumns, ...preferredColumns]) {
    if (!column.name || seenColumnNames.has(column.name)) {
      continue;
    }
    seenColumnNames.add(column.name);
    columns.push(column);
  }

  return columns;
}
