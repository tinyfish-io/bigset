import { z } from "zod";
import { backendUrl } from "./config.js";

const datasetColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().optional(),
  isPrimaryKey: z.boolean().optional(),
});

export const datasetSchema = z.object({
  _id: z.string(),
  _creationTime: z.number(),
  name: z.string(),
  description: z.string(),
  ownerId: z.string(),
  status: z.enum(["live", "paused", "building", "updating", "failed"]),
  lastStatusError: z.string().optional(),
  rowCount: z.number().optional(),
  maxRowCount: z.number().optional(),
  refreshCadence: z.string().optional(),
  columns: z.array(datasetColumnSchema),
});
export type Dataset = z.infer<typeof datasetSchema>;

const rowSchema = z.object({
  _id: z.string(),
  data: z.record(z.string(), z.unknown()),
  sources: z.array(z.string()).optional(),
  rowSummary: z.string().optional(),
  howFound: z.string().optional(),
});
export type DatasetRow = z.infer<typeof rowSchema>;

const inferredColumnSchema = z.object({
  name: z.string(),
  display_name: z.string(),
  type: z.string(),
  is_primary_key: z.boolean(),
  is_enumerable: z.boolean(),
  retrieval_hint: z.string(),
  nullable: z.boolean(),
});

const inferredSchemaSchema = z.object({
  dataset_name: z.string(),
  description: z.string(),
  columns: z.array(inferredColumnSchema),
  primary_key: z.union([z.string(), z.array(z.string())]),
  retrieval_strategy: z.string(),
  source_hint: z.string(),
});
export type InferredSchema = z.infer<typeof inferredSchemaSchema>;

const createDatasetResponseSchema = z.object({
  dataset: datasetSchema,
  schema: inferredSchemaSchema,
});

const listDatasetsResponseSchema = z.object({
  datasets: z.array(datasetSchema),
});

const getDatasetResponseSchema = z.object({
  dataset: datasetSchema,
});

const getRowsResponseSchema = z.object({
  rows: z.array(rowSchema),
});

const startRunResponseSchema = z.object({
  success: z.boolean(),
  runId: z.string(),
});

async function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${backendUrl()}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String(body.error)
        : `BigSet backend error (${res.status})`;
    throw new Error(message);
  }

  return schema.parse(body);
}

export async function createDataset(input: {
  prompt: string;
  maxRowCount: number;
  refreshCadence: string;
}) {
  return await requestJson("/cli/datasets", createDatasetResponseSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listDatasets() {
  return await requestJson("/cli/datasets", listDatasetsResponseSchema);
}

export async function getDataset(datasetId: string) {
  const result = await requestJson(
    `/cli/datasets/${encodeURIComponent(datasetId)}`,
    getDatasetResponseSchema,
  );
  return result.dataset;
}

export async function getRows(datasetId: string) {
  const result = await requestJson(
    `/cli/datasets/${encodeURIComponent(datasetId)}/rows`,
    getRowsResponseSchema,
  );
  return result.rows;
}

export async function populateDataset(datasetId: string) {
  return await requestJson(
    `/cli/datasets/${encodeURIComponent(datasetId)}/populate`,
    startRunResponseSchema,
    { method: "POST" },
  );
}

export async function stopDataset(datasetId: string) {
  return await requestJson(
    `/cli/datasets/${encodeURIComponent(datasetId)}/stop`,
    z.object({ success: z.boolean() }),
    { method: "POST" },
  );
}

export async function waitForDataset(
  datasetId: string,
  options: {
    intervalMs: number;
    timeoutMs: number;
    onPoll?: (dataset: Dataset) => void;
  },
): Promise<Dataset> {
  const startedAt = Date.now();
  for (;;) {
    const dataset = await getDataset(datasetId);
    options.onPoll?.(dataset);
    if (dataset.status === "live" || dataset.status === "failed") {
      return dataset;
    }
    if (Date.now() - startedAt > options.timeoutMs) {
      throw new Error(`Timed out waiting for dataset ${datasetId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
}
