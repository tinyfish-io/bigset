import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: "../.env.local" });
config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requiredPort(name: string): number {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export const env = {
  BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
  BETTER_AUTH_URL: required("BETTER_AUTH_URL"),
  CLIENT_ORIGIN: required("CLIENT_ORIGIN"),
  DATABASE_URL: required("DATABASE_URL"),
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || "openai/gpt-4.1-mini",
  PORT: requiredPort("PORT"),
  TINYFISH_API_KEY: process.env.TINYFISH_API_KEY,
};
