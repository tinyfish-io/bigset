import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import fastifyCors from "@fastify/cors";

import { inferSchema } from "./pipeline/schema-inference.js";
import { datasetContextSchema } from "./pipeline/populate.js";
import { populateRuntimePrerequisiteError } from "./pipeline/populate-runtime-prerequisites.js";
import {
  runSelfHealingPopulate,
  type PopulateDatasetRowWriter,
} from "./pipeline/populate-self-healing-runner.js";
import {
  createPopulateRecipeRuntime,
  type CreatePopulateRecipeRuntimeInput,
} from "./pipeline/populate-runtime-selection.js";

export interface BigSetServerEnv {
  CLIENT_ORIGIN: string;
  CONVEX_URL: string;
  CONVEX_ADMIN_KEY?: string;
  OPENROUTER_API_KEY?: string;
  TINYFISH_API_KEY?: string;
  POPULATE_RECIPE_STORE_DIR: string;
}

export interface BigSetPopulateDataset {
  ownerId: string;
}

export interface CreateBigSetServerInput {
  env: BigSetServerEnv;
  authPlugin?: FastifyPluginAsync;
  authPreHandler: (
    request: FastifyRequest,
    reply: FastifyReply
  ) => Promise<void> | void;
  getDatasetById: (datasetId: string) => Promise<BigSetPopulateDataset | null>;
  populateRowWriter: PopulateDatasetRowWriter;
  runtimeEnv?: NodeJS.ProcessEnv;
  inferSchemaFn?: typeof inferSchema;
  runSelfHealing?: typeof runSelfHealingPopulate;
  createRuntime?: (
    input: CreatePopulateRecipeRuntimeInput
  ) => Promise<CreatePopulateRecipeRuntimeResult>;
}

type CreatePopulateRecipeRuntimeResult = Awaited<
  ReturnType<typeof createPopulateRecipeRuntime>
>;

export async function createBigSetServer(
  input: CreateBigSetServerInput
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: true });
  const inferSchemaForRequest = input.inferSchemaFn ?? inferSchema;
  const runSelfHealing = input.runSelfHealing ?? runSelfHealingPopulate;
  const createRuntime = input.createRuntime ?? createPopulateRecipeRuntime;

  await fastify.register(fastifyCors, {
    origin: input.env.CLIENT_ORIGIN,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
    credentials: true,
    maxAge: 86400,
  });

  if (input.authPlugin) {
    await fastify.register(input.authPlugin);
  }

  fastify.get("/health", async () => ({ status: "ok" }));

  await fastify.register(async (instance) => {
    instance.addHook("preHandler", input.authPreHandler);

    instance.post("/infer-schema", async (req, reply) => {
      const body = req.body as { prompt?: string };
      if (!body?.prompt || typeof body.prompt !== "string" || !body.prompt.trim()) {
        return reply.code(400).send({ error: "prompt is required" });
      }

      try {
        const schema = await inferSchemaForRequest(body.prompt.trim());
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
        const dataset = await input.getDatasetById(parsed.data.datasetId);
        if (!dataset) {
          return reply.code(404).send({ error: "Dataset not found" });
        }
        const authenticatedUserId = req.auth?.userId;
        if (!authenticatedUserId) {
          return reply.code(401).send({ error: "Unauthenticated" });
        }
        if (dataset.ownerId !== authenticatedUserId) {
          return reply.code(403).send({ error: "Not authorized to populate this dataset" });
        }
        const prerequisiteError = populateRuntimePrerequisiteError({
          convexUrl: input.env.CONVEX_URL,
          convexAdminKey: input.env.CONVEX_ADMIN_KEY,
          openRouterApiKey: input.env.OPENROUTER_API_KEY,
          tinyFishApiKey: input.env.TINYFISH_API_KEY,
        });
        if (prerequisiteError) {
          return reply.code(500).send({
            error: prerequisiteError,
          });
        }

        const runtime = await createRuntime({
          env: input.runtimeEnv ?? process.env,
        });
        const result = await runSelfHealing({
          context: parsed.data,
          recipeStoreDirectory: input.env.POPULATE_RECIPE_STORE_DIR,
          rowWriter: input.populateRowWriter,
          shouldCommitRows: true,
          runtime,
        });

        req.log.info({
          action: result.action,
          datasetId: result.datasetId,
          committedRows: result.committedRows?.insertedRowCount ?? 0,
          validationIssues: result.validationIssues.slice(0, 5),
        }, "Self-healing populate completed");

        if (!result.success) {
          return reply.code(422).send({
            error: "Self-healing populate failed validation.",
            result: responseSafePopulateResult(result),
          });
        }

        return {
          success: true,
          result: responseSafePopulateResult(result),
        };
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

  return fastify;
}

function responseSafePopulateResult(
  result: Awaited<ReturnType<typeof runSelfHealingPopulate>>
) {
  const diagnosticRun = result.selectedRun ?? result.diagnosticRun;
  return {
    action: result.action,
    datasetId: result.datasetId,
    success: result.success,
    committedRows: result.committedRows,
    rejectionReasons: result.rejectionReasons,
    validationIssues: result.validationIssues,
    productionValidation: diagnosticRun?.productionValidation,
    metrics: diagnosticRun?.metrics,
    rowCount: diagnosticRun?.rows.length ?? 0,
  };
}
