import type {
  AgentHarnessStage,
  DatasetBuildPlan,
  DatasetColumnDefinition,
  DatasetSourceStrategy,
} from "./types.js";

export function createHarnessStages(
  sourceStrategy: DatasetSourceStrategy,
  hasMissingInputs: boolean
): AgentHarnessStage[] {
  const stages: AgentHarnessStage[] = [];

  if (hasMissingInputs) {
    stages.push({
      id: "clarify-missing-inputs",
      title: "Ask for missing inputs",
      purpose:
        "Pause before scraping when the target sites need user-specific values.",
      tool: "user_input",
      canRunWithoutUser: false,
    });
  }

  stages.push(
    {
      id: "discover-source-candidates",
      title: "Discover source candidates",
      purpose: "Use TinyFish Search to find source pages likely to contain rows.",
      tool: "tinyfish_search",
      canRunWithoutUser: true,
    },
    {
      id: "fetch-source-pages",
      title: "Fetch clean source content",
      purpose: "Use TinyFish Fetch before browser automation for speed and cost.",
      tool: "tinyfish_fetch",
      canRunWithoutUser: true,
    }
  );

  if (sourceStrategy !== "search_fetch") {
    stages.push({
      id: "browser-deep-extraction",
      title: "Deep browser extraction",
      purpose:
        "Use TinyFish Agent or browser automation only when search/fetch cannot reach the value.",
      tool: "tinyfish_agent",
      canRunWithoutUser: !hasMissingInputs,
    });
  }

  stages.push(
    {
      id: "validate-cells",
      title: "Validate extracted cells",
      purpose:
        "Reject rows that do not match schema, keep source URLs, and mark missing cells.",
      tool: "validator",
      canRunWithoutUser: true,
    },
    {
      id: "upsert-rows",
      title: "Replace changed row values",
      purpose:
        "Use the identity column to replace current values instead of appending duplicates.",
      tool: "database",
      canRunWithoutUser: true,
    }
  );

  return stages;
}

export function createTinyFishAgentGoal(plan: DatasetBuildPlan): string {
  const columnDescriptions = plan.schema.columns
    .map((column) => `- ${column.name}: ${column.description}`)
    .join("\n");

  return [
    `Build rows for dataset: ${plan.datasetName}.`,
    `User request: ${plan.userRequest}`,
    `Identity column: ${plan.schema.identityColumnName}`,
    "Return only rows backed by source URLs.",
    "Mark missing fields as null instead of guessing.",
    "Columns:",
    columnDescriptions,
  ].join("\n");
}

export function createTinyFishAgentOutputSchema(plan: DatasetBuildPlan) {
  const rowProperties = Object.fromEntries(
    plan.schema.columns.map((column) => [column.name, jsonSchemaForColumn(column)])
  );

  return {
    type: "object",
    additionalProperties: false,
    required: ["rows", "sourceUrls", "validationIssues"],
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [plan.schema.identityColumnName],
          properties: rowProperties,
        },
      },
      sourceUrls: {
        type: "array",
        items: { type: "string" },
      },
      validationIssues: {
        type: "array",
        items: { type: "string" },
      },
    },
  };
}

function jsonSchemaForColumn(column: DatasetColumnDefinition) {
  if (column.kind === "number") {
    return { type: ["number", "null"], description: column.description };
  }
  if (column.kind === "boolean") {
    return { type: ["boolean", "null"], description: column.description };
  }
  if (column.kind === "json") {
    return {
      type: ["object", "array", "null"],
      description: column.description,
    };
  }
  return { type: ["string", "null"], description: column.description };
}
