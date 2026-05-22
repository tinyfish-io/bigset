import { Output, ToolLoopAgent, stepCountIs } from "ai";
import { z } from "zod";

import { minimumRequiredColumnsForRunInput } from "./output.js";
import { createDatasetRecipe } from "./recipe-runtime.js";
import { validateDatasetRecipeScript } from "./playwright-recipe-runner.js";
import type {
  DatasetRecipeAuthor,
  DatasetRecipeAuthorGenerateInput,
  DatasetRecipeAuthorRepairInput,
} from "./self-healing-recipe-service.js";
import type { DatasetRecipeArtifact } from "./recipe-types.js";

const MAX_REPAIR_ARTIFACT_CHARS = 8_000;

const recipeScriptOutputSchema = z.object({
  scriptText: z.string().min(1),
  notes: z.array(z.string()).default([]),
});

interface RecipeAuthorGenerateResultLike {
  output?: unknown;
  text?: string;
}

interface RecipeAuthorAgentLike {
  generate(input: { prompt: string }): Promise<RecipeAuthorGenerateResultLike>;
}

interface CreateRecipeAuthorAgentInput {
  model: string;
  instructions: string;
}

type RecipeAuthorAgentFactory = (
  input: CreateRecipeAuthorAgentInput
) => RecipeAuthorAgentLike;

export class AiSdkDatasetRecipeAuthor implements DatasetRecipeAuthor {
  private readonly model: string;
  private readonly createAgent: RecipeAuthorAgentFactory;
  private readonly now: () => string;

  constructor(input: {
    model: string;
    createAgent?: RecipeAuthorAgentFactory;
    now?: () => string;
  }) {
    this.model = input.model;
    this.createAgent = input.createAgent ?? createRecipeAuthorAgent;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  async generateRecipe(
    input: DatasetRecipeAuthorGenerateInput
  ): Promise<ReturnType<typeof createDatasetRecipe>> {
    const minimumRequiredColumns = minimumRequiredColumnsForRunInput(
      input.runInput
    );
    const scriptText = await this.generateScript({
      prompt: createGenerateRecipePrompt(input),
    });

    return createDatasetRecipe({
      recipeId: recipeIdForVersion(input.datasetId, input.nextVersion),
      datasetId: input.datasetId,
      version: input.nextVersion,
      scriptText,
      requestedColumns: input.runInput.requiredColumns,
      minimumRequiredColumns,
      sourcePrompt: input.runInput.prompt,
      createdAt: this.now(),
      createdBy: "agent",
    });
  }

  async repairRecipe(
    input: DatasetRecipeAuthorRepairInput
  ): Promise<ReturnType<typeof createDatasetRecipe>> {
    const minimumRequiredColumns = minimumRequiredColumnsForRunInput(
      input.runInput
    );
    const scriptText = await this.generateScript({
      prompt: createRepairRecipePrompt(input),
    });

    return createDatasetRecipe({
      recipeId: recipeIdForVersion(input.datasetId, input.nextVersion),
      datasetId: input.datasetId,
      version: input.nextVersion,
      scriptText,
      requestedColumns: input.runInput.requiredColumns,
      minimumRequiredColumns,
      sourcePrompt: input.runInput.prompt,
      createdAt: this.now(),
      createdBy: "agent",
    });
  }

  private async generateScript(input: { prompt: string }): Promise<string> {
    const agent = this.createAgent({
      model: this.model,
      instructions: createRecipeAuthorInstructions(),
    });
    const generation = await agent.generate({ prompt: input.prompt });
    const parsed = parseRecipeScriptOutput(generation);
    validateDatasetRecipeScript(parsed.scriptText);
    return parsed.scriptText;
  }
}

function createRecipeAuthorAgent(
  input: CreateRecipeAuthorAgentInput
): RecipeAuthorAgentLike {
  return new ToolLoopAgent({
    model: input.model,
    instructions: input.instructions,
    tools: {},
    output: Output.object({ schema: recipeScriptOutputSchema }),
    stopWhen: stepCountIs(1),
  }) as unknown as RecipeAuthorAgentLike;
}

function createRecipeAuthorInstructions(): string {
  return [
    "You write BigSet dataset recipes.",
    "Return a JSON object with scriptText and notes.",
    "scriptText must be executable plain JavaScript source.",
    "scriptText must export async function runDatasetRecipe(context).",
    "Do not use TypeScript annotations, import modules, read files, access process, use eval, or write network code outside the provided page object.",
    "Use context.page for browser work, context.emitRow for rows, context.addEvidence for shared evidence, and context.log for diagnostics.",
    "Every emitted row must include cells, sourceUrls, evidence, and needsReview.",
    "Never invent missing values. Use null or omit unproven optional fields.",
  ].join("\n");
}

function createGenerateRecipePrompt(
  input: DatasetRecipeAuthorGenerateInput
): string {
  return JSON.stringify({
    task: "Generate the first durable browser recipe for this dataset.",
    datasetId: input.datasetId,
    nextVersion: input.nextVersion,
    userRequest: input.runInput.prompt,
    promptId: input.runInput.promptId,
    promptQuality: input.runInput.promptQuality,
    requestedColumns: input.runInput.requiredColumns,
    minimumRequiredColumns: minimumRequiredColumnsForRunInput(input.runInput),
    requiredExport: "export async function runDatasetRecipe(context)",
    contextApi: recipeContextApi(),
  });
}

function createRepairRecipePrompt(input: DatasetRecipeAuthorRepairInput): string {
  return JSON.stringify({
    task: "Repair a failed durable browser recipe for this dataset.",
    datasetId: input.datasetId,
    nextVersion: input.nextVersion,
    userRequest: input.runInput.prompt,
    requestedColumns: input.runInput.requiredColumns,
    minimumRequiredColumns: minimumRequiredColumnsForRunInput(input.runInput),
    activeRecipe: {
      recipeId: input.activeRecipe.recipeId,
      version: input.activeRecipe.version,
      scriptText: input.activeRecipe.scriptText,
    },
    failedRun: {
      runStatus: input.failedRun.runStatus,
      validationIssues: input.failedRun.validationIssues,
      productionValidation: input.failedRun.productionValidation,
      artifacts: summarizeArtifacts(input.failedRun.artifacts),
    },
    repairRules: [
      "Fix the failure cause. Do not only silence errors.",
      "Preserve good source/evidence behavior from the active recipe when possible.",
      "Return a full replacement scriptText, not a patch.",
      "The repaired script must still export runDatasetRecipe(context).",
    ],
    contextApi: recipeContextApi(),
  });
}

function recipeContextApi(): Record<string, string> {
  return {
    "context.page": "Playwright-like page. Use goto, locator, textContent, content, evaluate, url when available.",
    "context.input": "Dataset request with prompt, promptId, promptQuality, requiredColumns, minimumRequiredColumns.",
    "context.emitRow(row)": "Emit one dataset row with cells, sourceUrls, evidence, needsReview.",
    "context.addEvidence(evidence)": "Attach shared evidence with columnName, sourceUrl, quote.",
    "context.log(message)": "Record recipe diagnostics for repair artifacts.",
  };
}

function summarizeArtifacts(
  artifacts: DatasetRecipeArtifact[]
): Array<Pick<DatasetRecipeArtifact, "kind" | "label" | "content" | "uri">> {
  return artifacts.map((artifact) => ({
    kind: artifact.kind,
    label: artifact.label,
    content: artifact.content?.slice(0, MAX_REPAIR_ARTIFACT_CHARS),
    uri: artifact.uri,
  }));
}

function parseRecipeScriptOutput(
  generation: RecipeAuthorGenerateResultLike
): { scriptText: string; notes: string[] } {
  const payload = generation.output ?? parseJsonText(generation.text);
  const parsed = recipeScriptOutputSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `Recipe author returned invalid script output: ${parsed.error.message}`
    );
  }

  return {
    scriptText: stripMarkdownFence(parsed.data.scriptText.trim()),
    notes: parsed.data.notes,
  };
}

function parseJsonText(text: string | undefined): unknown {
  if (!text?.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function stripMarkdownFence(scriptText: string): string {
  const match = scriptText.match(
    /^```(?:ts|tsx|js|jsx|typescript|javascript)?\s*([\s\S]*?)\s*```$/i
  );
  return match?.[1]?.trim() ?? scriptText;
}

function recipeIdForVersion(datasetId: string, version: number): string {
  return `${safeRecipeIdSegment(datasetId)}-recipe-v${version}`;
}

function safeRecipeIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
