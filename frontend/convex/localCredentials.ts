import { internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";

const serviceValidator = v.union(
  v.literal("tinyfish"),
  v.literal("openrouter"),
);

const connectionMethodValidator = v.union(
  v.literal("api_key"),
  v.literal("oauth"),
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
    apiKey: v.string(),
    connectionMethod: connectionMethodValidator,
    verifiedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("localCredentials")
      .withIndex("by_service", (q) => q.eq("service", args.service))
      .unique();

    const update = {
      apiKey: args.apiKey,
      connectionMethod: args.connectionMethod,
      verifiedAt: args.verifiedAt,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, update);
      return existing._id;
    }

    return await ctx.db.insert("localCredentials", {
      service: args.service,
      ...update,
    });
  },
});
