import type { DatasetContext, PopulateColumn } from "./populate.js";
import type { PopulateRuntimeResult } from "./populate-runtime.js";
import {
  emptyPopulateRuntimeResult,
  populateRecipeRunResultFromRuntimeResult,
  type PopulateRecipe,
  type PopulateRecipeRunResult,
  type PopulateRecipeRuntime,
} from "./populate-self-healing.js";

export interface CollectionPopulatePipelineColumn {
  name: string;
  type: PopulateColumn["type"];
  description?: string;
}

export interface CollectionPopulatePipelineInput {
  datasetId: string;
  datasetName: string;
  description: string;
  columns: CollectionPopulatePipelineColumn[];
  requiredColumns: string[];
  prompt: string;
  recipeInstructions: string;
  targetRows: number;
}

export type CollectionPopulatePipelineRunner = (
  input: CollectionPopulatePipelineInput
) => Promise<PopulateRuntimeResult>;

export interface CollectionPopulateRecipeRuntimeOptions {
  runPipeline: CollectionPopulatePipelineRunner;
  targetRows?: number;
}

export class CollectionPopulateRecipeRuntime implements PopulateRecipeRuntime {
  constructor(private readonly input: CollectionPopulateRecipeRuntimeOptions) {}

  async runRecipe(input: {
    recipe: PopulateRecipe;
    context: DatasetContext;
  }): Promise<PopulateRecipeRunResult> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    let result: PopulateRuntimeResult;
    let failureMessage: string | undefined;

    try {
      result = await this.input.runPipeline(
        collectionPipelineInputFromRecipe({
          recipe: input.recipe,
          context: input.context,
          targetRows: this.input.targetRows ?? 10,
        })
      );
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
      result = emptyPopulateRuntimeResult([failureMessage]);
    }

    return populateRecipeRunResultFromRuntimeResult({
      recipe: input.recipe,
      context: input.context,
      result,
      failureMessage,
      startedAt,
      startedAtMs,
    });
  }
}

export function collectionPipelineInputFromRecipe(input: {
  recipe: PopulateRecipe;
  context: DatasetContext;
  targetRows: number;
}): CollectionPopulatePipelineInput {
  const recipeInstructions = input.recipe.runtimeInstructions.trim();
  return {
    datasetId: input.context.datasetId,
    datasetName: input.context.datasetName,
    description: input.context.description,
    columns: input.context.columns.map((column) => ({
      name: column.name,
      type: column.type,
      description: column.description,
    })),
    requiredColumns: input.context.columns.map((column) => column.name),
    prompt: buildCollectionPopulatePrompt({
      context: input.context,
      recipeInstructions,
    }),
    recipeInstructions,
    targetRows: input.targetRows,
  };
}

function buildCollectionPopulatePrompt(input: {
  context: DatasetContext;
  recipeInstructions: string;
}): string {
  const columnLines = input.context.columns.map((column) => {
    const description = column.description ? ` - ${column.description}` : "";
    return `- ${column.name} (${column.type})${description}`;
  });
  const parts = [
    `Dataset: ${input.context.datasetName}`,
    `Task: ${input.context.description}`,
    "",
    "Requested columns:",
    ...columnLines,
  ];

  if (input.recipeInstructions) {
    parts.push(
      "",
      "Durable recipe instructions:",
      input.recipeInstructions
    );
  }

  return parts.join("\n");
}
