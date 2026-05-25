import { env } from "../env.js";
import { convex, internal } from "../convex.js";
import type {
  PopulateDatasetRowWriter,
  PopulateDatasetWriteResult,
} from "./populate-self-healing-runner.js";

interface ConvexMutationClient {
  mutation(functionReference: unknown, args: unknown): Promise<unknown>;
}

export class ConvexPopulateDatasetRowWriter implements PopulateDatasetRowWriter {
  constructor(
    private readonly input: {
      convexClient?: ConvexMutationClient;
      internalApi?: typeof internal;
    } = {}
  ) {}

  async replaceRows(input: Parameters<PopulateDatasetRowWriter["replaceRows"]>[0]):
    Promise<PopulateDatasetWriteResult> {
    if (!env.CONVEX_ADMIN_KEY) {
      throw new Error(
        "CONVEX_SELF_HOSTED_ADMIN_KEY is required to commit self-healed populate rows."
      );
    }

    const convexClient = this.input.convexClient ?? convex;
    const internalApi = this.input.internalApi ?? internal;
    const replacement = await convexClient.mutation(
      internalApi.datasetRows.replaceByDataset,
      {
        datasetId: input.datasetId,
        rows: input.rows.map((row) => ({
          data: row.cells,
          sources: row.sourceUrls,
          evidence: row.evidence,
        })),
      }
    );

    return normalizeReplacementResult(replacement, input.rows.length);
  }
}

function normalizeReplacementResult(
  value: unknown,
  fallbackInsertedRowCount: number
): PopulateDatasetWriteResult {
  if (
    typeof value === "object" &&
    value !== null &&
    "insertedRowCount" in value
  ) {
    const replacement = value as {
      clearedRowCount?: unknown;
      insertedRowCount?: unknown;
    };
    return {
      clearedRowCount: typeof replacement.clearedRowCount === "number"
        ? replacement.clearedRowCount
        : undefined,
      insertedRowCount: typeof replacement.insertedRowCount === "number"
        ? replacement.insertedRowCount
        : fallbackInsertedRowCount,
    };
  }

  return {
    insertedRowCount: fallbackInsertedRowCount,
  };
}
