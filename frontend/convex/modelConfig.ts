import { query, mutation, internalQuery, internalMutation } from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { v } from "convex/values";
import { getIdentity } from "./lib/authz.js";

type LlmProvider =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "deepseek"
  | "qwen"
  | "mistral"
  | "groq"
  | "togetherai"
  | "deepinfra"
  | "fireworks"
  | "huggingface"
  | "ollama"
  | "lmstudio"
  | "custom";

const providerValidator = v.union(
  v.literal("openrouter"),
  v.literal("openai"),
  v.literal("anthropic"),
  v.literal("google"),
  v.literal("xai"),
  v.literal("deepseek"),
  v.literal("qwen"),
  v.literal("mistral"),
  v.literal("groq"),
  v.literal("togetherai"),
  v.literal("deepinfra"),
  v.literal("fireworks"),
  v.literal("huggingface"),
  v.literal("ollama"),
  v.literal("lmstudio"),
  v.literal("custom"),
);

async function findProviderConfig(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  provider: LlmProvider,
) {
  const providerRow = await ctx.db
    .query("modelConfig")
    .withIndex("by_user_provider", (q) =>
      q.eq("userId", userId).eq("provider", provider),
    )
    .first();

  if (providerRow) return providerRow;

  if (provider === "openrouter") {
    return await ctx.db
      .query("modelConfig")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("provider"), undefined))
      .first();
  }

  return null;
}

export const get = query({
  args: { provider: v.optional(providerValidator) },
  handler: async (ctx, args) => {
    const identity = await getIdentity(ctx);
    if (!identity) return null;

    return await findProviderConfig(
      ctx,
      identity.subject,
      args.provider ?? "openrouter",
    );
  },
});

/**
 * Upsert one or more model preferences for the authenticated user and provider.
 *
 * Only fields that are explicitly provided (not undefined) are updated.
 * Unset fields retain their existing database values.
 */
export const upsert = mutation({
  args: {
    provider: v.optional(providerValidator),
    schemaInference: v.optional(v.string()),
    populateOrchestrator: v.optional(v.string()),
    investigateSubagent: v.optional(v.string()),
    extractorBuilder: v.optional(v.string()),
    rowExtractorConcurrency: v.optional(v.number()),
    rowExtractorBrowserAttempts: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await getIdentity(ctx);
    if (!identity) throw new Error("Not authenticated");

    const provider = args.provider ?? "openrouter";
    const existing = await findProviderConfig(ctx, identity.subject, provider);

    const patch: {
      provider?: LlmProvider;
      schemaInference?: string;
      populateOrchestrator?: string;
      investigateSubagent?: string;
      extractorBuilder?: string;
      rowExtractorConcurrency?: number;
      rowExtractorBrowserAttempts?: number;
    } = { provider };
    if (args.schemaInference !== undefined) patch.schemaInference = args.schemaInference;
    if (args.populateOrchestrator !== undefined) patch.populateOrchestrator = args.populateOrchestrator;
    if (args.investigateSubagent !== undefined) patch.investigateSubagent = args.investigateSubagent;
    if (args.extractorBuilder !== undefined) patch.extractorBuilder = args.extractorBuilder;
    if (args.rowExtractorConcurrency !== undefined) patch.rowExtractorConcurrency = args.rowExtractorConcurrency;
    if (args.rowExtractorBrowserAttempts !== undefined) patch.rowExtractorBrowserAttempts = args.rowExtractorBrowserAttempts;

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("modelConfig", {
        userId: identity.subject,
        ...patch,
      });
    }
  },
});

export const getInternal = internalQuery({
  args: { userId: v.string(), provider: v.optional(providerValidator) },
  handler: async (ctx, args) => {
    return await findProviderConfig(
      ctx,
      args.userId,
      args.provider ?? "openrouter",
    );
  },
});

/**
 * Upsert model preferences for a specific user/provider (internal, backend-only).
 *
 * Only fields that are explicitly provided (not undefined) are updated.
 */
export const upsertInternal = internalMutation({
  args: {
    userId: v.string(),
    provider: v.optional(providerValidator),
    schemaInference: v.optional(v.string()),
    populateOrchestrator: v.optional(v.string()),
    investigateSubagent: v.optional(v.string()),
    extractorBuilder: v.optional(v.string()),
    rowExtractorConcurrency: v.optional(v.number()),
    rowExtractorBrowserAttempts: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const provider = args.provider ?? "openrouter";
    const existing = await findProviderConfig(ctx, args.userId, provider);

    const patch: {
      provider: LlmProvider;
      schemaInference?: string;
      populateOrchestrator?: string;
      investigateSubagent?: string;
      extractorBuilder?: string;
      rowExtractorConcurrency?: number;
      rowExtractorBrowserAttempts?: number;
    } = { provider };
    if (args.schemaInference !== undefined) patch.schemaInference = args.schemaInference;
    if (args.populateOrchestrator !== undefined) patch.populateOrchestrator = args.populateOrchestrator;
    if (args.investigateSubagent !== undefined) patch.investigateSubagent = args.investigateSubagent;
    if (args.extractorBuilder !== undefined) patch.extractorBuilder = args.extractorBuilder;
    if (args.rowExtractorConcurrency !== undefined) patch.rowExtractorConcurrency = args.rowExtractorConcurrency;
    if (args.rowExtractorBrowserAttempts !== undefined) patch.rowExtractorBrowserAttempts = args.rowExtractorBrowserAttempts;

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("modelConfig", {
        userId: args.userId,
        ...patch,
      });
    }
  },
});
