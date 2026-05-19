import { ConvexHttpClient } from "convex/browser";

import { env } from "./env.js";

export { api } from "../../frontend/convex/_generated/api.js";

export const convex = new ConvexHttpClient(env.CONVEX_URL);
