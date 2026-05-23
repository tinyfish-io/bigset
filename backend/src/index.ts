import Fastify from "fastify";
import fastifyCors from "@fastify/cors";

import { env } from "./env.js";
import clerkAuthPlugin, { requireAuth, getUserEmail } from "./clerk-auth.js";
import { inferSchema } from "./pipeline/schema-inference.js";
import { datasetContextSchema } from "./pipeline/populate.js";
import { populateWorkflow } from "./mastra/workflows/populate.js";
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
      if (dataset.ownerId !== req.auth.userId) {
        return reply.code(403).send({ error: "Not authorized to populate this dataset" });
      }

      const run = await populateWorkflow.createRun();
      // Server-set auth/run context — threaded through every step so the
      // dataset-tools layer can attribute capability-violation logs and
      // PostHog events to a specific user + workflow run. NOT validated
      // against the client request body (see populateInputSchema in
      // mastra/workflows/populate.ts).
      const result = await run.start({
        inputData: {
          ...parsed.data,
          authContext: {
            authorizedUserId: req.auth!.userId,
            workflowRunId: run.runId,
          },
        },
      });

      req.log.info({ workflowStatus: result.status, steps: JSON.stringify(result.steps).slice(0, 2000) }, "Populate workflow completed");

      if (result.status !== "success") {
        throw new Error(`Workflow ended with status: ${result.status}`);
      }

      // Fire the "dataset ready" email. Best-effort: any failure here
      // is logged + tracked but does NOT fail the API response. The
      // dataset is ready regardless of whether we managed to notify.
      //
      // Order of guards (all must pass to send):
      //   1. Dataset still exists (delete-race protection)
      //   2. Dataset has at least one row (no "ready" email for empty datasets)
      //   3. User has a primary email on their Clerk record
      //   4. Resend accepts the send
      //
      // The dataset doc is re-read from Convex so we use the CURRENT name
      // in the email subject + body (rename-race protection) — the value
      // in `parsed.data.datasetName` came from the request body and could
      // be stale by the time the workflow finishes.
      const notifyUserId = req.auth!.userId;
      const notifyDatasetId = parsed.data.datasetId;
      try {
        const currentDataset = await convex.query(
          internal.datasets.getInternal,
          { id: notifyDatasetId },
        );
        if (!currentDataset) {
          req.log.info(
            { datasetId: notifyDatasetId },
            "Dataset no longer exists post-workflow; skipping notification",
          );
        } else {
          const rowCount = await convex.query(
            internal.datasetRows.countByDataset,
            { datasetId: notifyDatasetId },
          );
          if (rowCount === 0) {
            req.log.info(
              { datasetId: notifyDatasetId },
              "Populate workflow succeeded but produced 0 rows; skipping notification",
            );
          } else {
            // ── Lifecycle transition ─────────────────────────────────
            // Dataset has rows + is usable → flip status from "building"
            // to "live". Patch is idempotent; safe to call when status
            // is already "live" (e.g. a manual repopulate of an existing
            // live dataset). Done BEFORE the email so a Resend hiccup
            // can't leave a usable dataset stuck in "building".
            try {
              await convex.mutation(internal.datasets.setStatusInternal, {
                id: notifyDatasetId,
                status: "live",
              });
            } catch (statusErr) {
              // Status update failure is logged but doesn't block the
              // rest of the notify flow — the dataset is still usable,
              // the badge just stays "building" until the next populate.
              req.log.error(
                { err: statusErr, datasetId: notifyDatasetId },
                "Failed to transition dataset status to 'live'; populate already succeeded",
              );
            }

            const email = await getUserEmail(req.server.clerk, notifyUserId);
            const baseProps = {
              datasetId: notifyDatasetId,
              datasetName: currentDataset.name,
              rowCount,
              workflowType: "populate" as const,
            };
            if (!email) {
              req.log.warn(
                { userId: notifyUserId },
                "No primary email on Clerk record; skipping dataset-ready notification",
              );
              capture({
                distinctId: notifyUserId,
                event: EVENTS.DATASET_READY_EMAIL_FAILED,
                properties: { ...baseProps, error_kind: "no_recipient" },
              });
            } else {
              try {
                await sendTransactionalEmail(
                  email,
                  datasetReadyTemplate({
                    datasetName: currentDataset.name,
                    rowCount,
                    datasetUrl: `${env.CLIENT_ORIGIN}/dataset/${notifyDatasetId}`,
                  }),
                );
                capture({
                  distinctId: notifyUserId,
                  event: EVENTS.DATASET_READY_EMAIL_SENT,
                  properties: {
                    ...baseProps,
                    recipientDomain: emailDomain(email),
                  },
                });
              } catch (sendErr) {
                req.log.error(
                  { err: sendErr, datasetId: notifyDatasetId },
                  "Failed to send dataset-ready email; populate already succeeded",
                );
                capture({
                  distinctId: notifyUserId,
                  event: EVENTS.DATASET_READY_EMAIL_FAILED,
                  properties: { ...baseProps, error_kind: "send_failed" },
                });
              }
            }
          }
        }
      } catch (notifyErr) {
        // Catch-all for unexpected errors in the notify flow itself
        // (e.g. Convex query failure). Already logged; never re-thrown.
        req.log.error(
          { err: notifyErr, datasetId: notifyDatasetId },
          "Notify block crashed unexpectedly; populate already succeeded",
        );
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
