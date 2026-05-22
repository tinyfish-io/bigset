import { env } from "./env.js";
import clerkAuthPlugin, { requireAuth } from "./clerk-auth.js";
import { ConvexPopulateDatasetRowWriter } from "./pipeline/populate-convex-writer.js";
import { convex, api } from "./convex.js";
import { createBigSetServer } from "./server.js";

const fastify = await createBigSetServer({
  env,
  authPlugin: clerkAuthPlugin,
  authPreHandler: requireAuth,
  getDatasetById: (datasetId) => convex.query(api.datasets.get, { id: datasetId }),
  populateRowWriter: new ConvexPopulateDatasetRowWriter(),
});

try {
  await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
