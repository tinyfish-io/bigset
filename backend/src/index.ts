import { env } from "./env.js";
import clerkAuthPlugin, { requireAuth } from "./clerk-auth.js";
import { ConvexPopulateDatasetOwnerLoader } from "./pipeline/populate-dataset-owner-loader.js";
import { ConvexPopulateDatasetRowWriter } from "./pipeline/populate-convex-writer.js";
import { convex, internal } from "./convex.js";
import { createBigSetServer } from "./server.js";

const datasetOwnerLoader = new ConvexPopulateDatasetOwnerLoader({
  convexClient: convex,
  internalApi: internal,
});

const fastify = await createBigSetServer({
  env,
  authPlugin: clerkAuthPlugin,
  authPreHandler: requireAuth,
  getDatasetById: (datasetId) => datasetOwnerLoader.loadDataset(datasetId),
  populateRowWriter: new ConvexPopulateDatasetRowWriter(),
});

try {
  await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
