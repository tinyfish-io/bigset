import Fastify, { type FastifyBaseLogger } from "fastify";
import fastifyCors from "@fastify/cors";
import type { ClerkClient } from "@clerk/backend";

import { env } from "./env.js";
import clerkAuthPlugin, { requireAuth, getUserEmail } from "./clerk-auth.js";
import { inferSchema } from "./pipeline/schema-inference.js";
import { datasetContextSchema, type DatasetContext } from "./pipeline/populate.js";
import { populateWorkflow } from "./mastra/workflows/populate.js";
import { updateWorkflow } from "./mastra/workflows/update.js";
import { appendWorkflow } from "./mastra/workflows/append.js";
import { convex, internal } from "./convex.js";
import { sendTransactionalEmail } from "./email/send.js";
import { datasetReadyTemplate } from "./email/templates/dataset-ready.js";
import { capture, shutdown as shutdownAnalytics } from "./analytics/posthog.js";
import { EVENTS } from "./analytics/events.js";

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
type AppendWorkflowRun = Awaited<ReturnType<typeof appendWorkflow.createRun>>;

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
}: {
  input: DatasetContext;
  run: UpdateWorkflowRun;
  authorizedUserId: string;
  logger: FastifyBaseLogger;
  clerk: ClerkClient;
}): Promise<void> {
  const datasetId = input.datasetId;

  try {
    const result = await run.start({
      inputData: {
        ...input,
        authContext: {
          authorizedUserId,
          workflowRunId: run.runId,
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
}: {
  input: DatasetContext;
  run: PopulateWorkflowRun;
  authorizedUserId: string;
  logger: FastifyBaseLogger;
  clerk: ClerkClient;
}): Promise<void> {
  const datasetId = input.datasetId;

  try {
    const result = await run.start({
      inputData: {
        ...input,
        authContext: {
          authorizedUserId,
          workflowRunId: run.runId,
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

/**
 * Append workflow background runner.
 *
 * Nearly identical to runPopulateWorkflowInBackground with two differences:
 *   1. No clearRows step — rows are preserved and the agent adds to them.
 *   2. The 0-rows guard only fails if the dataset is *still* empty after the
 *      run (priorRowCount === 0 AND finalCount === 0). If rows existed before
 *      and no new ones were added, the run is treated as successful (idempotent).
 */
async function runAppendWorkflowInBackground({
  input,
  run,
  priorRowCount,
  authorizedUserId,
  logger,
  clerk,
}: {
  input: DatasetContext;
  run: AppendWorkflowRun;
  priorRowCount: number;
  authorizedUserId: string;
  logger: FastifyBaseLogger;
  clerk: ClerkClient;
}): Promise<void> {
  const datasetId = input.datasetId;

  try {
    const result = await run.start({
      inputData: {
        ...input,
        authContext: {
          authorizedUserId,
          workflowRunId: run.runId,
        },
      },
    });

    logger.info(
      {
        workflowStatus: result.status,
        steps: JSON.stringify(result.steps).slice(0, 2000),
      },
      "Append workflow completed",
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
        "Dataset no longer exists post-append; skipping status transition and notification",
      );
      return;
    }

    const rowCount = await convex.query(
      internal.datasetRows.countByDataset,
      { datasetId },
    );

    // Only treat 0 rows as a failure if the dataset was already empty — meaning
    // the agent genuinely found nothing. If rows existed before (priorRowCount > 0)
    // and no new ones were added, the run was idempotent, not broken.
    if (rowCount === 0 && priorRowCount === 0) {
      throw new Error("Append workflow completed with 0 rows");
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
    logger.error({ err, datasetId }, "Append background workflow failed");

    try {
      const currentDataset = await convex.query(internal.datasets.getInternal, {
        id: datasetId,
      });
      if (!currentDataset) {
        logger.info(
          { datasetId },
          "Dataset no longer exists after failed append; skipping failed status transition",
        );
        return;
      }
      await setDatasetPopulateStatus(datasetId, "failed", lastStatusError);
    } catch (statusErr) {
      logger.error(
        { err: statusErr, datasetId },
        "Failed to transition dataset status to 'failed' after append",
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
      });

      return reply.code(202).send({ success: true, runId: run.runId });
    } catch (err) {
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

      void runUpdateWorkflowInBackground({
        input: parsed.data,
        run,
        authorizedUserId: auth.userId,
        logger: req.log,
        clerk: req.server.clerk,
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

  instance.post("/append", async (req, reply) => {
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

      // Append reuses the same "building" status and claim as clear & populate.
      // The only difference is that rows are not wiped first.
      const appendOutcome = await beginDatasetPopulate(
        parsed.data.datasetId,
        auth.userId,
      );

      if (appendOutcome === "not_found") {
        return reply.code(404).send({ error: "Dataset not found" });
      }
      if (appendOutcome === "forbidden") {
        return reply.code(403).send({ error: "Not authorized to populate this dataset" });
      }
      if (appendOutcome === "already_building") {
        return reply.code(409).send({ error: "Dataset is already being populated" });
      }
      if (appendOutcome === "already_updating") {
        return reply.code(409).send({ error: "Dataset is currently being updated" });
      }
      if (appendOutcome !== "started") {
        throw new Error(`Unexpected append claim outcome: ${appendOutcome}`);
      }

      // Read the prior row count before starting so the background runner can
      // apply the correct 0-rows guard (only fail if empty both before and after).
      const priorRowCount = await convex.query(
        internal.datasetRows.countByDataset,
        { datasetId: parsed.data.datasetId },
      );

      let run: AppendWorkflowRun;
      try {
        run = await appendWorkflow.createRun();
      } catch (runErr) {
        req.log.error(runErr, "Failed to create append workflow run; releasing dataset claim");
        await setDatasetPopulateStatus(parsed.data.datasetId, "failed", statusErrorMessage(runErr));
        return reply.code(502).send({ error: "Failed to populate dataset. Please try again." });
      }

      void runAppendWorkflowInBackground({
        input: parsed.data,
        run,
        priorRowCount,
        authorizedUserId: auth.userId,
        logger: req.log,
        clerk: req.server.clerk,
      });

      return reply.code(202).send({ success: true, runId: run.runId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("validator") || msg.includes("Invalid")) {
        return reply.code(400).send({ error: "Invalid datasetId" });
      }
      req.log.error(err, "Append failed");
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
