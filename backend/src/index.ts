import Fastify from "fastify";
import fastifyCors from "@fastify/cors";

import { env } from "./env.js";
import clerkAuthPlugin, { requireAuth } from "./clerk-auth.js";
import { inferSchema } from "./pipeline/schema-inference.js";
import { datasetContextSchema } from "./pipeline/populate.js";
import { populateWorkflow } from "./mastra/workflows/populate.js";
import { convex, api } from "./convex.js";

const fastify = Fastify({ logger: true });

await fastify.register(fastifyCors, {
  origin: env.CLIENT_ORIGIN,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  credentials: true,
  maxAge: 86400,
});

// Make `fastify.clerk` available and warn on missing CLERK_SECRET_KEY.
// `requireAuth` (also exported from ./clerk-auth) is the preHandler for
// protected routes — see the example block below.
await fastify.register(clerkAuthPlugin);

// ────────────────────────────────────────────────────────────────────────
//  Public routes
// ────────────────────────────────────────────────────────────────────────

fastify.get("/health", async () => ({ status: "ok" }));

// ────────────────────────────────────────────────────────────────────────
//  Protected routes — gated by Clerk JWT verification
// ────────────────────────────────────────────────────────────────────────

await fastify.register(async (instance) => {
  instance.addHook("preHandler", requireAuth);

  instance.post("/infer-schema", async (req, reply) => {
    const body = req.body as { prompt?: string };
    if (!body?.prompt || typeof body.prompt !== "string" || !body.prompt.trim()) {
      return reply.code(400).send({ error: "prompt is required" });
    }

    try {
      const schema = await inferSchema(body.prompt.trim());
      return schema;
    } catch (err) {
      req.log.error(err, "Schema inference failed");
      return reply.code(502).send({ error: "Schema inference failed. Please try again." });
    }
  });

  instance.post("/populate", async (req, reply) => {
    const parsed = datasetContextSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const dataset = await convex.query(api.datasets.get, { id: parsed.data.datasetId });
      if (!dataset) {
        return reply.code(404).send({ error: "Dataset not found" });
      }
      if (dataset.ownerId !== req.auth.userId) {
        return reply.code(403).send({ error: "Not authorized to populate this dataset" });
      }

      const run = await populateWorkflow.createRun();
      const result = await run.start({ inputData: parsed.data });

      req.log.info({ workflowStatus: result.status, steps: JSON.stringify(result.steps).slice(0, 2000) }, "Populate workflow completed");

      if (result.status !== "success") {
        throw new Error(`Workflow ended with status: ${result.status}`);
      }

      return { success: true, result: result.result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("validator") || msg.includes("Invalid")) {
        return reply.code(400).send({ error: "Invalid datasetId" });
      }
      req.log.error(err, "Populate failed");
      return reply.code(502).send({ error: "Failed to populate dataset. Please try again." });
    }
  });
});

try {
  await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
