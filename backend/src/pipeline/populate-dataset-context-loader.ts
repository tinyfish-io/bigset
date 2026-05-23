import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

import {
  datasetContextSchema,
  type DatasetContext,
} from "./populate.js";

export interface PopulateDatasetContextQueryClient {
  query(functionReference: unknown, args: unknown): Promise<unknown>;
}

export class ConvexPopulateDatasetContextLoader {
  constructor(
    private readonly input: {
      convexClient: PopulateDatasetContextQueryClient;
      internalApi?: typeof anyApi;
    }
  ) {}

  async loadContext(datasetId: string): Promise<DatasetContext> {
    const internalApi = this.input.internalApi ?? anyApi;
    const dataset = await this.input.convexClient.query(
      internalApi.datasets.getForSystemPopulate,
      { id: datasetId }
    );

    if (!dataset || typeof dataset !== "object") {
      throw new Error(`Dataset ${datasetId} not found.`);
    }
    const record = dataset as {
      name?: unknown;
      description?: unknown;
      columns?: unknown;
    };

    return datasetContextSchema.parse({
      datasetId,
      datasetName: record.name,
      description: record.description,
      columns: record.columns,
    });
  }
}

export function createConvexPopulateDatasetContextLoader(input: {
  convexUrl: string;
  convexAdminKey: string;
}): ConvexPopulateDatasetContextLoader {
  const convexClient = new ConvexHttpClient(input.convexUrl);
  (convexClient as unknown as {
    setAdminAuth(adminKey: string): void;
  }).setAdminAuth(input.convexAdminKey);

  return new ConvexPopulateDatasetContextLoader({ convexClient });
}
