import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const cwdEnv = resolve(process.cwd(), ".env");
const parentEnv = resolve(process.cwd(), "..", ".env");

loadDotenv({ path: existsSync(cwdEnv) ? cwdEnv : parentEnv });

export function backendUrl(): string {
  return (
    process.env.BIGSET_BACKEND_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    `http://localhost:${process.env.PORT || "3501"}`
  ).replace(/\/$/, "");
}
