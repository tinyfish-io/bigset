import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
  BETTER_AUTH_URL: required("BETTER_AUTH_URL"),
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN || "http://localhost:3500",
  DATABASE_URL: required("DATABASE_URL"),
  PORT: Number(process.env.PORT || "3501"),
};
