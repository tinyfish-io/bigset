import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { datasetContextSchema } from "../../pipeline/populate.js";
import {
  finalizeAcquisitionResult,
  runSearchAcquisitionPhase,
} from "../../pipeline/populate-acquisition.js";
import { PopulateCollectionMemoryService } from "../../pipeline/collection-memory/index.js";
import { resolvePopulateCollectionMemoryConfig } from "../../pipeline/populate-collection-memory-config.js";
import { runParallelPopulatePhase } from "../../pipeline/populate-parallel.js";
import {
  buildPopulateColumnKeyAliases,
  normalizePopulateRowCellsForDataset,
} from "../../pipeline/populate-normalize-dataset-keys.js";
import { resolvePopulateRuntimeLimits } from "../../pipeline/populate-runtime-limits.js";
import type { DatasetSchema } from "../../pipeline/types.js";
import { createTinyFishWebTools } from "../../pipeline/populate-runtime.js";
import { populateAcquisitionResultSchema } from "../../pipeline/populate-acquisition.js";

const clearRowsStep = createStep({
  id: "clear-rows",
  inputSchema: datasetContextSchema,
  outputSchema: datasetContextSchema,
  execute: async ({ inputData }) => {
    const { convex, internal } = await import("../../convex.js");
    console.log(`[clear-rows] Clearing rows for dataset ${inputData.datasetId}`);
    await convex.mutation(internal.datasetRows.clearByDataset, {
      datasetId: inputData.datasetId,
    });
    console.log(`[clear-rows] Done`);
    return inputData;
  },
});

const acquireSourcesStep = createStep({
  id: "acquire-sources",
  inputSchema: datasetContextSchema,
  outputSchema: z.object({
    context: datasetContextSchema,
    acquisition: populateAcquisitionResultSchema,
    dataSpec: z.any(),
  }),
  execute: async ({ inputData }) => {
    const limits = resolvePopulateRuntimeLimits();
    const metrics = {
      searchCalls: 0,
      fetchCalls: 0,
      browserCalls: 0,
      agentRuns: 0,
      agentSteps: 0,
    };
    const validationIssues: string[] = [];
    const debugNotes: string[] = [];
    const acquisitionPhase = await runSearchAcquisitionPhase({
      context: inputData,
      maxSearchCalls: limits.maxSearchCalls,
      webTools: createTinyFishWebTools(),
      metrics,
      validationIssues,
      debugNotes,
    });
    const acquisition = finalizeAcquisitionResult(
      acquisitionPhase,
      limits.maxFetchCalls
    );
    console.log(
      `[acquire-sources] ${acquisition.prioritizedUrls.length} prioritized URL(s) from ${metrics.searchCalls} search(es)`
    );
    return {
      context: inputData,
      acquisition,
      dataSpec: acquisitionPhase.dataSpec,
    };
  },
});

const populateStep = createStep({
  id: "populate-dataset",
  inputSchema: z.object({
    context: datasetContextSchema,
    acquisition: populateAcquisitionResultSchema,
    dataSpec: z.any(),
  }),
  outputSchema: z.object({ text: z.string() }),
  execute: async ({ inputData }) => {
    const limits = resolvePopulateRuntimeLimits();
    const metrics = {
      searchCalls: 0,
      fetchCalls: 0,
      browserCalls: 0,
      agentRuns: 0,
      agentSteps: 0,
    };
    const validationIssues: string[] = [];
    const debugNotes: string[] = [];

    const memoryConfig = resolvePopulateCollectionMemoryConfig();
    const collectionMemory = memoryConfig.enabled
      ? new PopulateCollectionMemoryService({
          datasetId: inputData.context.datasetId,
          userPrompt: inputData.context.description,
          memoryDir: memoryConfig.memoryDir,
        })
      : undefined;
    if (collectionMemory) {
      await collectionMemory.load();
      debugNotes.push(
        `Collection memory loaded (${collectionMemory.snapshot?.agent_visited_urls.length ?? 0} prior agent visit(s)).`
      );
    }

    const result = await runParallelPopulatePhase({
      context: inputData.context,
      dataSpec: inputData.dataSpec,
      acquisition: inputData.acquisition,
      limits,
      webTools: createTinyFishWebTools(),
      metrics,
      validationIssues,
      debugNotes,
      collectionMemory,
    });

    if (collectionMemory) {
      await collectionMemory.save();
      debugNotes.push("Collection memory saved.");
    }

    const { convex, internal } = await import("../../convex.js");
    const columnKeyAliases = buildPopulateColumnKeyAliases(
      inputData.dataSpec as DatasetSchema,
      inputData.context
    );
    const replacement = await convex.mutation(internal.datasetRows.replaceByDataset, {
      datasetId: inputData.context.datasetId,
      rows: result.rows.map((row) => ({
        data: normalizePopulateRowCellsForDataset(row.cells, columnKeyAliases),
        sources: row.sourceUrls,
      })),
    });
    console.log(
      `[populate-dataset] Wrote ${replacement.insertedRowCount} row(s) to Convex (${result.validationIssues.length} validation note(s))`
    );

    return {
      text: JSON.stringify({
        rows: result.rows,
        validationIssues: result.validationIssues,
        metrics,
        insertedRowCount: replacement.insertedRowCount,
      }),
    };
  },
});

export const populateWorkflow = createWorkflow({
  id: "populate-workflow",
  inputSchema: datasetContextSchema,
  outputSchema: z.object({ text: z.string() }),
})
  .then(clearRowsStep)
  .then(acquireSourcesStep)
  .then(populateStep)
  .commit();
