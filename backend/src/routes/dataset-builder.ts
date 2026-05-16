import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";

import { auth } from "../auth.js";
import { env } from "../env.js";
import { createTinyFishAgentGoal, createTinyFishAgentOutputSchema } from "../dataset-builder/agent-harness.js";
import { createOpenRouterPlannerClient } from "../dataset-builder/openrouter.js";
import { createDatasetBuildPlan } from "../dataset-builder/planner.js";
import type {
  DatasetBuildRequest,
  DatasetPlanningMode,
  DatasetUpdateCadence,
} from "../dataset-builder/types.js";

export async function registerDatasetBuilderRoutes(fastify: FastifyInstance) {
  fastify.post("/api/dataset-builder/plan", async (request, reply) => {
    const userId = await requireAuthenticatedUserId(request, reply);
    if (!userId) {
      return;
    }

    const parsedRequest = parseDatasetBuildRequestBody(request.body);
    if (!parsedRequest.ok) {
      return reply.status(400).send({
        error: "Invalid dataset build request",
        details: parsedRequest.error,
      });
    }

    const plan = await createDatasetBuildPlan(parsedRequest.value, {
      openRouterClient: createOpenRouterPlannerClient({
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL,
      }),
    });

    return reply.send({
      planId: randomUUID(),
      ownerUserId: userId,
      plan,
      tinyFishAgentGoal: createTinyFishAgentGoal(plan),
      tinyFishAgentOutputSchema: createTinyFishAgentOutputSchema(plan),
    });
  });
}

async function requireAuthenticatedUserId(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<string | null> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });

  if (!session) {
    reply.status(401).send({ error: "Unauthorized" });
    return null;
  }

  return session.user.id;
}

function parseDatasetBuildRequestBody(
  body: unknown
): { ok: true; value: DatasetBuildRequest } | { ok: false; error: string } {
  if (!isRecord(body)) {
    return { ok: false, error: "Body must be a JSON object." };
  }

  const userRequest = stringValue(body.userRequest) ?? stringValue(body.prompt);
  if (!userRequest?.trim()) {
    return { ok: false, error: "`userRequest` is required." };
  }

  const updateCadence = parseUpdateCadence(body.updateCadence);
  if (body.updateCadence && !updateCadence) {
    return {
      ok: false,
      error: "`updateCadence` must be manual, hourly, daily, or weekly.",
    };
  }

  const planningMode = parsePlanningMode(body.planningMode);
  if (body.planningMode && !planningMode) {
    return {
      ok: false,
      error: "`planningMode` must be deterministic or openrouter.",
    };
  }

  return {
    ok: true,
    value: {
      userRequest,
      updateCadence,
      planningMode: planningMode ?? "openrouter",
      providedInputs: parseStringRecord(body.providedInputs),
      preferredColumns: parseStringArray(body.preferredColumns),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string");
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

function parseUpdateCadence(value: unknown): DatasetUpdateCadence | undefined {
  if (
    value === "manual" ||
    value === "hourly" ||
    value === "daily" ||
    value === "weekly"
  ) {
    return value;
  }

  return undefined;
}

function parsePlanningMode(value: unknown): DatasetPlanningMode | undefined {
  if (value === "deterministic" || value === "openrouter") {
    return value;
  }

  return undefined;
}
