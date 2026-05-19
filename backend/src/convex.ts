import { ConvexHttpClient } from "convex/browser";

import { env } from "./env.js";

export const convex = new ConvexHttpClient(env.CONVEX_URL);
