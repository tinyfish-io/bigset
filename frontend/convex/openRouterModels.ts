import { query, mutation } from "./_generated/server.js";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const models = await ctx.db.query("openRouterModels").collect();
    return models.sort((a, b) => a.modelName.localeCompare(b.modelName));
  },
});

export const upsertBatch = mutation({
  args: {
    models: v.array(
      v.object({
        modelName: v.string(),
        canonicalSlug: v.string(),
        contextLength: v.number(),
        completionCost: v.number(),
        promptCost: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("openRouterModels").collect();
    for (const model of existing) {
      await ctx.db.delete(model._id);
    }

    for (const model of args.models) {
      await ctx.db.insert("openRouterModels", {
        modelName: model.modelName,
        canonicalSlug: model.canonicalSlug,
        contextLength: model.contextLength,
        completionCost: model.completionCost,
        promptCost: model.promptCost,
      });
    }
  },
});