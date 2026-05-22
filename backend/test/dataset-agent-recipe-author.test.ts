import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AiSdkDatasetRecipeAuthor,
  PlaywrightRecipeRunner,
  createDatasetRecipe,
  createDatasetRecipeRunResult,
} from "../src/dataset-agent/index.js";
import type {
  DatasetAgentRunInput,
  DatasetRecipeAuthorRepairInput,
  DatasetRecipeRunResult,
} from "../src/dataset-agent/index.js";

const runInput: DatasetAgentRunInput = {
  prompt: "Find latest blog posts from OpenAI with title and source URL.",
  promptId: "recipe-author-fixture",
  promptQuality: "good",
  requiredColumns: ["entity_name", "latest_post_title", "source_url"],
};

test("AI SDK recipe author generates an executable recipe script", async () => {
  const prompts: string[] = [];
  const author = new AiSdkDatasetRecipeAuthor({
    model: "test-model",
    now: () => "2026-05-22T00:00:00.000Z",
    createAgent: () => ({
      generate: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          output: {
            scriptText: `
              export async function runDatasetRecipe({ page, emitRow }) {
                await page.goto("https://fixture.local/news");
                const sourceUrl = page.url();
                emitRow({
                  cells: {
                    entity_name: "OpenAI",
                    latest_post_title: "Release notes",
                    source_url: sourceUrl
                  },
                  sourceUrls: [sourceUrl],
                  evidence: [{
                    columnName: "latest_post_title",
                    sourceUrl,
                    quote: "Release notes"
                  }],
                  needsReview: false
                });
              }
            `,
            notes: ["fixture recipe"],
          },
        };
      },
    }),
  });

  const recipe = await author.generateRecipe({
    datasetId: "dataset-ai-posts",
    runInput,
    nextVersion: 1,
  });
  const runResult = await new PlaywrightRecipeRunner({
    browserFactory: async () => ({
      page: new StaticFixturePage(),
      close: async () => {},
    }),
  }).runRecipe({ recipe, runInput });

  assert.equal(recipe.recipeId, "dataset-ai-posts-recipe-v1");
  assert.equal(recipe.createdBy, "agent");
  assert.match(prompts[0] ?? "", /Generate the first durable browser recipe/);
  assert.match(prompts[0] ?? "", /latest_post_title/);
  assert.equal(runResult.runStatus, "succeeded");
  assert.equal(runResult.productionValidation.isValid, true);
});

test("AI SDK recipe author includes failed run artifacts when repairing", async () => {
  let repairPrompt = "";
  const author = new AiSdkDatasetRecipeAuthor({
    model: "test-model",
    now: () => "2026-05-22T00:01:00.000Z",
    createAgent: () => ({
      generate: async ({ prompt }) => {
        repairPrompt = prompt;
        return {
          output: {
            scriptText: `
              export async function runDatasetRecipe({ emitRow }) {
                emitRow({
                  cells: {
                    entity_name: "OpenAI",
                    latest_post_title: "Fixed title",
                    source_url: "https://openai.com/news"
                  },
                  sourceUrls: ["https://openai.com/news"],
                  evidence: [{
                    columnName: "latest_post_title",
                    sourceUrl: "https://openai.com/news",
                    quote: "Fixed title"
                  }],
                  needsReview: false
                });
              }
            `,
          },
        };
      },
    }),
  });
  const activeRecipe = createDatasetRecipe({
    recipeId: "dataset-ai-posts-recipe-v1",
    datasetId: "dataset-ai-posts",
    version: 1,
    status: "active",
    scriptText: "export async function runDatasetRecipe() { throw new Error('old selector'); }",
    requestedColumns: runInput.requiredColumns,
    sourcePrompt: runInput.prompt,
  });
  const repairedRecipe = await author.repairRecipe({
    datasetId: "dataset-ai-posts",
    runInput,
    nextVersion: 2,
    activeRecipe,
    failedRun: failedRunResult(activeRecipe),
  });

  assert.equal(repairedRecipe.recipeId, "dataset-ai-posts-recipe-v2");
  assert.match(repairPrompt, /Repair a failed durable browser recipe/);
  assert.match(repairPrompt, /Old selector failed/);
  assert.match(repairPrompt, /recipe stderr/);
  assert.match(repairPrompt, /old selector/);
});

test("AI SDK recipe author rejects scripts without runDatasetRecipe export", async () => {
  const author = new AiSdkDatasetRecipeAuthor({
    model: "test-model",
    createAgent: () => ({
      generate: async () => ({
        output: {
          scriptText: "export async function notTheRecipe() {}",
        },
      }),
    }),
  });

  await assert.rejects(
    () =>
      author.generateRecipe({
        datasetId: "dataset-ai-posts",
        runInput,
        nextVersion: 1,
      }),
    /runDatasetRecipe/
  );
});

function failedRunResult(
  recipe: DatasetRecipeAuthorRepairInput["activeRecipe"]
): DatasetRecipeRunResult {
  return createDatasetRecipeRunResult({
    recipe,
    runInput,
    result: {
      rows: [],
      validationIssues: ["Old selector failed."],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      metrics: {
        searchCalls: 0,
        fetchCalls: 0,
        browserCalls: 1,
        agentRuns: 0,
        agentSteps: 0,
      },
    },
    runStatus: "failed",
    startedAt: "2026-05-22T00:00:00.000Z",
    completedAt: "2026-05-22T00:00:01.000Z",
    runtimeMs: 1_000,
    artifacts: [
      {
        kind: "stderr",
        label: "recipe stderr",
        content: "Old selector failed.",
      },
    ],
  });
}

class StaticFixturePage {
  private currentUrl = "";

  async goto(url: string): Promise<void> {
    this.currentUrl = url;
  }

  url(): string {
    return this.currentUrl;
  }

  async content(): Promise<string> {
    return "<html><body>fixture</body></html>";
  }
}
