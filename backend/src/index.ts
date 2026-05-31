import Fastify, { type FastifyBaseLogger } from "fastify";
import fastifyCors from "@fastify/cors";
import type { ClerkClient } from "@clerk/backend";

import { env } from "./env.js";
import clerkAuthPlugin, { requireAuth, getUserEmail } from "./clerk-auth.js";
import { inferSchema } from "./pipeline/schema-inference.js";
import { datasetContextSchema, type DatasetContext } from "./pipeline/populate.js";
import { populateWorkflow } from "./mastra/workflows/populate.js";
import { updateWorkflow } from "./mastra/workflows/update.js";
import { convex, internal } from "./convex.js";
import { sendTransactionalEmail } from "./email/send.js";
import { datasetReadyTemplate } from "./email/templates/dataset-ready.js";
import { capture, shutdown as shutdownAnalytics } from "./analytics/posthog.js";
import { EVENTS } from "./analytics/events.js";
import { mastra } from "./mastra/index.js";

/** Domain part of an email, for analytics (we never log full addresses). */
function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "unknown";
}

type DatasetPopulateStatus = "building" | "live" | "failed";
type DatasetPopulateBeginOutcome =
  | "started"
  | "not_found"
  | "forbidden"
  | "already_building"
  | "already_updating";
type PopulateWorkflowRun = Awaited<ReturnType<typeof populateWorkflow.createRun>>;

type DatasetUpdateBeginOutcome =
  | "started"
  | "not_found"
  | "forbidden"
  | "already_building"
  | "already_updating";
type UpdateWorkflowRun = Awaited<ReturnType<typeof updateWorkflow.createRun>>;

function statusErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

async function setDatasetPopulateStatus(
  datasetId: string,
  status: DatasetPopulateStatus,
  lastStatusError?: string,
): Promise<void> {
  await convex.mutation(internal.datasets.setStatusInternal, {
    id: datasetId,
    status,
    lastStatusError,
  });
}

async function beginDatasetPopulate(
  datasetId: string,
  ownerId: string,
): Promise<DatasetPopulateBeginOutcome> {
  const claim = await convex.mutation(internal.datasets.beginPopulateInternal, {
    id: datasetId,
    ownerId,
  });

  return claim.outcome;
}

async function sendDatasetReadyNotification({
  logger,
  clerk,
  userId,
  datasetId,
  datasetName,
  rowCount,
  workflowType = "populate",
}: {
  logger: FastifyBaseLogger;
  clerk: ClerkClient;
  userId: string;
  datasetId: string;
  datasetName: string;
  rowCount: number;
  workflowType?: "populate" | "update";
}): Promise<void> {
  const baseProps = {
    datasetId,
    datasetName,
    rowCount,
    workflowType,
  };

  try {
    const email = await getUserEmail(clerk, userId);
    if (!email) {
      logger.warn(
        { userId },
        "No primary email on Clerk record; skipping dataset-ready notification",
      );
      capture({
        distinctId: userId,
        event: EVENTS.DATASET_READY_EMAIL_FAILED,
        properties: { ...baseProps, error_kind: "no_recipient" },
      });
      return;
    }

    try {
      await sendTransactionalEmail(
        email,
        datasetReadyTemplate({
          datasetName,
          rowCount,
          datasetUrl: `${env.CLIENT_ORIGIN}/dataset/${datasetId}`,
        }),
      );
      capture({
        distinctId: userId,
        event: EVENTS.DATASET_READY_EMAIL_SENT,
        properties: {
          ...baseProps,
          recipientDomain: emailDomain(email),
        },
      });
    } catch (sendErr) {
      logger.error(
        { err: sendErr, datasetId },
        "Failed to send dataset-ready email; populate already succeeded",
      );
      capture({
        distinctId: userId,
        event: EVENTS.DATASET_READY_EMAIL_FAILED,
        properties: { ...baseProps, error_kind: "send_failed" },
      });
    }
  } catch (notifyErr) {
    logger.error(
      { err: notifyErr, datasetId },
      "Notify block crashed unexpectedly; populate already succeeded",
    );
  }
}

async function beginDatasetUpdate(
  datasetId: string,
  ownerId: string,
): Promise<DatasetUpdateBeginOutcome> {
  const claim = await convex.mutation(internal.datasets.beginUpdateInternal, {
    id: datasetId,
    ownerId,
  });
  return claim.outcome;
}

async function runUpdateWorkflowInBackground({
  input,
  run,
  authorizedUserId,
  logger,
  clerk,
  modelConfig,
}: {
  input: DatasetContext;
  run: UpdateWorkflowRun;
  authorizedUserId: string;
  logger: FastifyBaseLogger;
  clerk: ClerkClient;
  modelConfig: {
    schemaInference: string;
    populateOrchestrator: string;
    investigateSubagent: string;
  };
}): Promise<void> {
  const datasetId = input.datasetId;

  try {
    const result = await run.start({
      inputData: {
        ...input,
        authContext: {
          authorizedUserId,
          workflowRunId: run.runId,
          modelConfig,
        },
      },
    });

    logger.info(
      {
        workflowStatus: result.status,
        steps: JSON.stringify(result.steps).slice(0, 2000),
      },
      "Update workflow completed",
    );

    if (result.status !== "success") {
      throw new Error(`Workflow ended with status: ${result.status}`);
    }

    const currentDataset = await convex.query(internal.datasets.getInternal, {
      id: datasetId,
    });
    if (!currentDataset) {
      logger.info(
        { datasetId },
        "Dataset no longer exists post-update; skipping status transition",
      );
      return;
    }

    await setDatasetPopulateStatus(datasetId, "live");

    const rowCount = await convex.query(
      internal.datasetRows.countByDataset,
      { datasetId },
    );
    await sendDatasetReadyNotification({
      logger,
      clerk,
      userId: authorizedUserId,
      datasetId,
      datasetName: currentDataset.name,
      rowCount,
      workflowType: "update",
    });
  } catch (err) {
    const lastStatusError = statusErrorMessage(err);
    logger.error({ err, datasetId }, "Update background workflow failed");

    try {
      const currentDataset = await convex.query(internal.datasets.getInternal, {
        id: datasetId,
      });
      if (!currentDataset) {
        logger.info(
          { datasetId },
          "Dataset no longer exists after failed update; skipping failed status transition",
        );
        return;
      }
      await setDatasetPopulateStatus(datasetId, "failed", lastStatusError);
    } catch (statusErr) {
      logger.error(
        { err: statusErr, datasetId },
        "Failed to transition dataset status to 'failed' after update",
      );
    }
  }
}

async function runPopulateWorkflowInBackground({
  input,
  run,
  authorizedUserId,
  logger,
  clerk,
  modelConfig,
}: {
  input: DatasetContext;
  run: PopulateWorkflowRun;
  authorizedUserId: string;
  logger: FastifyBaseLogger;
  clerk: ClerkClient;
  modelConfig: {
    schemaInference: string;
    populateOrchestrator: string;
    investigateSubagent: string;
  };
}): Promise<void> {
  const datasetId = input.datasetId;

  try {
    const result = await run.start({
      inputData: {
        ...input,
        authContext: {
          authorizedUserId,
          workflowRunId: run.runId,
          modelConfig,
        },
      },
    });

    logger.info(
      {
        workflowStatus: result.status,
        steps: JSON.stringify(result.steps).slice(0, 2000),
      },
      "Populate workflow completed",
    );

    if (result.status !== "success") {
      throw new Error(`Workflow ended with status: ${result.status}`);
    }

    const currentDataset = await convex.query(internal.datasets.getInternal, {
      id: datasetId,
    });
    if (!currentDataset) {
      logger.info(
        { datasetId },
        "Dataset no longer exists post-workflow; skipping status transition and notification",
      );
      return;
    }

    const rowCount = await convex.query(
      internal.datasetRows.countByDataset,
      { datasetId },
    );
    if (rowCount === 0) {
      throw new Error("Populate workflow completed with 0 rows");
    }

    await setDatasetPopulateStatus(datasetId, "live");
    await sendDatasetReadyNotification({
      logger,
      clerk,
      userId: authorizedUserId,
      datasetId,
      datasetName: currentDataset.name,
      rowCount,
    });
  } catch (err) {
    const lastStatusError = statusErrorMessage(err);
    logger.error(
      { err, datasetId },
      "Populate background workflow failed",
    );

    try {
      const currentDataset = await convex.query(internal.datasets.getInternal, {
        id: datasetId,
      });
      if (!currentDataset) {
        logger.info(
          { datasetId },
          "Dataset no longer exists after failed populate; skipping failed status transition",
        );
        return;
      }

      await setDatasetPopulateStatus(datasetId, "failed", lastStatusError);
    } catch (statusErr) {
      logger.error(
        { err: statusErr, datasetId },
        "Failed to transition dataset status to 'failed'",
      );
    }
  }
}

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

// Flush queued PostHog events on graceful shutdown so a SIGTERM mid-flight
// doesn't drop the dataset_ready_email_sent capture from the last request.
fastify.addHook("onClose", async () => {
  await shutdownAnalytics();
});

// ────────────────────────────────────────────────────────────────────────
//  Public routes
// ────────────────────────────────────────────────────────────────────────

fastify.get("/health", async () => ({ status: "ok" }));


fastify.post("/openrouter/refresh", { preHandler: requireAuth }, async (req, reply) => {
  const { fetchModelsFromOpenRouter, upsertModelBatch } = await import("./config/models.js");
  try {
    const models = await fetchModelsFromOpenRouter();
    await upsertModelBatch(models);
    return { success: true, models };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to refresh models";
    req.log.error(err, "OpenRouter refresh failed");
    return reply.code(500).send({ error: message });
  }
});

fastify.get("/openrouter/models", async (req, reply) => {
  const { getCachedModels } = await import("./config/models.js");
  try {
    const models = await getCachedModels();
    return { models };
  } catch (err) {
    req.log.error(err, "Failed to load cached models");
    return reply.code(500).send({ error: "Failed to load models" });
  }
});

// ────────────────────────────────────────────────────────────────────────
//  Protected routes — gated by Clerk JWT verification
// ────────────────────────────────────────────────────────────────────────

await fastify.register(async (instance) => {
  instance.addHook("preHandler", requireAuth);

  instance.get("/settings/models", async (req) => {
    const { getModelConfig } = await import("./config/models.js");
    const config = await getModelConfig(req.auth!.userId);
    return { config };
  });

  instance.post("/settings/models", async (req, reply) => {
    const { upsertModelConfig, validateModelSlug, getCachedModels } = await import("./config/models.js");
    const body = req.body as {
      schemaInference?: string | null;
      populateOrchestrator?: string | null;
      investigateSubagent?: string | null;
    };

    const toValidate: Array<{ role: "schemaInference" | "populateOrchestrator" | "investigateSubagent"; slug: string }> = [];
    if (body.schemaInference) toValidate.push({ role: "schemaInference", slug: body.schemaInference });
    if (body.populateOrchestrator) toValidate.push({ role: "populateOrchestrator", slug: body.populateOrchestrator });
    if (body.investigateSubagent) toValidate.push({ role: "investigateSubagent", slug: body.investigateSubagent });

    if (toValidate.length > 0) {
      try {
        const models = await getCachedModels();
        for (const { role, slug } of toValidate) {
          const found = models.some((m) => m.canonicalSlug === slug);
          if (!found) {
            return reply.code(400).send({
              error: `Invalid model slug "${slug}" for ${role}. Refresh the model list first or choose a different model.`,
            });
          }
        }
      } catch (err) {
        req.log.error(err, "Failed to validate model slugs — allowing save");
      }
    }

    try {
      await upsertModelConfig(req.auth!.userId, {
        schemaInference: body.schemaInference ?? undefined,
        populateOrchestrator: body.populateOrchestrator ?? undefined,
        investigateSubagent: body.investigateSubagent ?? undefined,
      });
      return { success: true };
    } catch (err) {
      req.log.error(err, "Failed to save model config");
      return reply.code(500).send({ error: "Failed to save model preferences" });
    }
  });

  instance.post("/infer-schema", async (req, reply) => {
    const body = req.body as { prompt?: string; modelSlug?: string };
    if (!body?.prompt || typeof body.prompt !== "string" || !body.prompt.trim()) {
      return reply.code(400).send({ error: "prompt is required" });
    }

    try {
      const auth = req.auth;
      let modelSlug = body.modelSlug;

      if (!modelSlug && auth) {
        const { getModelConfig } = await import("./config/models.js");
        const config = await getModelConfig(auth.userId);
        if (config?.schemaInference) {
          modelSlug = config.schemaInference;
        }
      }

      const schema = await inferSchema(body.prompt.trim(), modelSlug);
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
      const auth = req.auth;
      if (!auth) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      const populateOutcome = await beginDatasetPopulate(
        parsed.data.datasetId,
        auth.userId,
      );

      if (populateOutcome === "not_found") {
        return reply.code(404).send({ error: "Dataset not found" });
      }
      if (populateOutcome === "forbidden") {
        return reply.code(403).send({ error: "Not authorized to populate this dataset" });
      }
      if (populateOutcome === "already_building") {
        return reply.code(409).send({ error: "Dataset is already being populated" });
      }
      if (populateOutcome !== "started") {
        throw new Error(`Unexpected populate claim outcome: ${populateOutcome}`);
      }

      const { getModelConfig } = await import("./config/models.js");
      const modelConfig = await getModelConfig(auth.userId);

      let run: Awaited<ReturnType<typeof populateWorkflow.createRun>>;
      try {
        run = await populateWorkflow.createRun();
      } catch (runErr) {
        req.log.error(runErr, "Failed to create workflow run; releasing dataset claim");
        await setDatasetPopulateStatus(parsed.data.datasetId, "failed", statusErrorMessage(runErr));
        return reply.code(502).send({ error: "Failed to populate dataset. Please try again." });
      }

      void runPopulateWorkflowInBackground({
        input: parsed.data,
        run,
        authorizedUserId: auth.userId,
        logger: req.log,
        clerk: req.server.clerk,
        modelConfig,
      });

      return reply.code(202).send({ success: true, runId: run.runId });
    } catch (err) {
      await mastra.observability.getDefaultInstance()?.flush();
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("validator") || msg.includes("Invalid")) {
        return reply.code(400).send({ error: "Invalid datasetId" });
      }
      req.log.error(err, "Populate failed");
      return reply.code(502).send({ error: "Failed to populate dataset. Please try again." });
    }
  });

  instance.post("/update", async (req, reply) => {
    const parsed = datasetContextSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const auth = req.auth;
      if (!auth) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      const updateOutcome = await beginDatasetUpdate(
        parsed.data.datasetId,
        auth.userId,
      );

      if (updateOutcome === "not_found") {
        return reply.code(404).send({ error: "Dataset not found" });
      }
      if (updateOutcome === "forbidden") {
        return reply.code(403).send({ error: "Not authorized to update this dataset" });
      }
      if (updateOutcome === "already_building") {
        return reply.code(409).send({ error: "Dataset is being populated" });
      }
      if (updateOutcome === "already_updating") {
        return reply.code(409).send({ error: "Dataset is already being updated" });
      }
      if (updateOutcome !== "started") {
        throw new Error(`Unexpected update claim outcome: ${updateOutcome}`);
      }

      let run: UpdateWorkflowRun;
      try {
        run = await updateWorkflow.createRun();
      } catch (runErr) {
        req.log.error(runErr, "Failed to create update workflow run; reverting dataset status");
        await setDatasetPopulateStatus(parsed.data.datasetId, "live");
        return reply.code(502).send({ error: "Failed to update dataset. Please try again." });
      }

      const { getModelConfig } = await import("./config/models.js");
      const modelConfig = await getModelConfig(auth.userId);

      void runUpdateWorkflowInBackground({
        input: parsed.data,
        run,
        authorizedUserId: auth.userId,
        logger: req.log,
        clerk: req.server.clerk,
        modelConfig,
      });

      return reply.code(202).send({ success: true, runId: run.runId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("validator") || msg.includes("Invalid")) {
        return reply.code(400).send({ error: "Invalid datasetId" });
      }
      req.log.error(err, "Update failed");
      return reply.code(502).send({ error: "Failed to update dataset. Please try again." });
    }
  });
});

try {
  await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
