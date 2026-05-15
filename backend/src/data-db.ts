import { drizzle } from "drizzle-orm/node-postgres";

import { env } from "./env.js";

export const dataDb = drizzle(env.DATA_DATABASE_URL);
