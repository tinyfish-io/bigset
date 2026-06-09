import { internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";

const serviceValidator = v.union(
  v.literal("tinyfish"),
  v.literal("llm"),
  v.literal("openrouter"),
  v.literal("openai"),
  v.literal("anthropic"),
  v.literal("custom"),
);

const connectionMethodValidator = v.union(
  v.literal("api_key"),
  v.literal("oauth"),
);

const llmProviderValidator = v.union(
  v.literal("openrouter"),
  v.literal("openai"),
  v.literal("anthropic"),
  v.literal("custom"),
);

export const getInternal = internalQuery({
  args: { service: serviceValidator },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("localCredentials")
      .withIndex("by_service", (q) => q.eq("service", args.service))
      .unique();
  },
});

export const upsertInternal = internalMutation({
  args: {
    service: serviceValidator,
    keychainAccount: v.optional(v.string()),
    connectionMethod: connectionMethodValidator,
    verifiedAt: v.number(),
    llmProvider: v.optional(llmProviderValidator),
    llmBaseUrl: v.optional(v.string()),
    llmDefaultModel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("localCredentials")
      .withIndex("by_service", (q) => q.eq("service", args.service))
      .unique();

    const update = {
      ...(args.keychainAccount !== undefined
        ? { keychainAccount: args.keychainAccount }
        : {}),
      connectionMethod: args.connectionMethod,
      verifiedAt: args.verifiedAt,
      updatedAt: Date.now(),
    };
    const llmPatch = args.llmProvider !== undefined
      ? {
          llmProvider: args.llmProvider,
          // Explicit undefined clears stale custom-provider values when the
          // user switches back to OpenAI/Anthropic/OpenRouter.
          llmBaseUrl: args.llmBaseUrl,
          llmDefaultModel: args.llmDefaultModel,
        }
      : {};
    const llmInsert = args.llmProvider !== undefined
      ? {
          llmProvider: args.llmProvider,
          ...(args.llmBaseUrl !== undefined ? { llmBaseUrl: args.llmBaseUrl } : {}),
          ...(args.llmDefaultModel !== undefined ? { llmDefaultModel: args.llmDefaultModel } : {}),
        }
      : {};

    if (existing) {
      await ctx.db.patch(existing._id, { ...update, ...llmPatch, apiKey: undefined });
      return existing._id;
    }

    return await ctx.db.insert("localCredentials", {
      service: args.service,
      ...update,
      ...llmInsert,
    });
  },
});

export const clearLegacyPlaintextInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("localCredentials").collect();
    let cleared = 0;

    for (const row of rows) {
      if (row.apiKey !== undefined) {
        await ctx.db.patch(row._id, { apiKey: undefined });
        cleared += 1;
      }
    }

    return { cleared };
  },
});
