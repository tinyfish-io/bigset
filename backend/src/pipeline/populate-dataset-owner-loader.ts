import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

export interface PopulateDatasetOwnerQueryClient {
  query(functionReference: unknown, args: unknown): Promise<unknown>;
}

export interface PopulateDatasetOwnerRecord {
  ownerId: string;
}

export class ConvexPopulateDatasetOwnerLoader {
  constructor(
    private readonly input: {
      convexClient: PopulateDatasetOwnerQueryClient;
      internalApi?: typeof anyApi;
    }
  ) {}

  async loadDataset(datasetId: string): Promise<PopulateDatasetOwnerRecord | null> {
    const internalApi = this.input.internalApi ?? anyApi;
    const dataset = await this.input.convexClient.query(
      internalApi.datasets.getForSystemPopulate,
      { id: datasetId }
    );

    if (!dataset || typeof dataset !== "object") {
      return null;
    }
    const ownerId = (dataset as { ownerId?: unknown }).ownerId;
    if (typeof ownerId !== "string" || !ownerId) {
      throw new Error(`Dataset ${datasetId} is missing ownerId.`);
    }
    return { ownerId };
  }
}

export function createConvexPopulateDatasetOwnerLoader(input: {
  convexUrl: string;
  convexAdminKey: string;
}): ConvexPopulateDatasetOwnerLoader {
  const convexClient = new ConvexHttpClient(input.convexUrl);
  (convexClient as unknown as {
    setAdminAuth(adminKey: string): void;
  }).setAdminAuth(input.convexAdminKey);

  return new ConvexPopulateDatasetOwnerLoader({ convexClient });
}
