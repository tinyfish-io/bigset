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

/** Domain part of an email, for analytics (we never log full addresses). */
function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "unknown";
}

type DatasetPopulateStatus = "building" | "live" | "failed";
type PopulateWorkflowRun = Awaited<ReturnType<typeof populateWorkflow.createRun>>;

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

async function sendDatasetReadyNotification({
  logger,
  clerk,
  userId,
  datasetId,
  datasetName,
  rowCount,
}: {
  logger: FastifyBaseLogger;
  clerk: ClerkClient;
  userId: string;
  datasetId: string;
  datasetName: string;
  rowCount: number;
}): Promise<void> {
  const baseProps = {
    datasetId,
    datasetName,
    rowCount,
    workflowType: "populate" as const,
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

      // Ownership check uses the INTERNAL (admin-callable, no-authz) getter.
      // We can't use `api.datasets.get` here because that runs through
      // `loadReadableDataset`, which requires either a Clerk-identified
      // caller OR visibility="public". The backend's ConvexHttpClient is
      // admin-authed but does NOT impersonate a user, so private datasets
      // (the typical case) get rejected as `anonymous_private`.
      //
      // The /populate route enforces ownership against `req.auth.userId`
      // (from the verified Clerk JWT) immediately below — that's the
      // authoritative check, not Convex's user-identity authz.
      const dataset = await convex.query(internal.datasets.getInternal, {
        id: parsed.data.datasetId,
      });
      if (!dataset) {
        return reply.code(404).send({ error: "Dataset not found" });
      }
      if (dataset.ownerId !== auth.userId) {
        return reply.code(403).send({ error: "Not authorized to populate this dataset" });
      }

      const run = await populateWorkflow.createRun();
      await setDatasetPopulateStatus(parsed.data.datasetId, "building");
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

      const dataset = await convex.query(internal.datasets.getInternal, {
        id: parsed.data.datasetId,
      });
      if (!dataset) {
        return reply.code(404).send({ error: "Dataset not found" });
      }
      if (dataset.ownerId !== auth.userId) {
        return reply.code(403).send({ error: "Not authorized to update this dataset" });
      }

      const run = await updateWorkflow.createRun();
      const result = await run.start({
        inputData: {
          ...parsed.data,
          authContext: {
            authorizedUserId: auth.userId,
            workflowRunId: run.runId,
          },
        },
      });

      req.log.info({ workflowStatus: result.status }, "Update workflow completed");

      if (result.status !== "success") {
        throw new Error(`Workflow ended with status: ${result.status}`);
      }

      return { success: true, result: result.result };
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
