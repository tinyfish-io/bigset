import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { Entry } from "@napi-rs/keyring";

import {
  isLocalCredentialService,
  localKeychainAccount,
} from "./local-credential-types.js";

const rootEnvPath = resolve(process.cwd(), "../.env");
if (existsSync(rootEnvPath)) {
  loadDotenv({ path: rootEnvPath });
}

const KEYCHAIN_SERVICE = "ai.bigset.local-credentials";
const MAX_BODY_BYTES = 64 * 1024;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for the local keychain bridge.`);
  }
  return value;
}

function numberEnv(name: string): number {
  const raw = requiredEnv(name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

const bindHost = process.env.LOCAL_KEYCHAIN_BIND_HOST || "127.0.0.1";
const port = numberEnv("LOCAL_KEYCHAIN_PORT");
const token = requiredEnv("LOCAL_KEYCHAIN_TOKEN");
const workspaceId = requiredEnv("BIGSET_LOCAL_WORKSPACE_ID");

interface CredentialBody {
  service?: unknown;
  apiKey?: unknown;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function credentialEntry(service: unknown): { entry: Entry; account: string } {
  if (!isLocalCredentialService(service)) {
    throw new Error("Unsupported credential service.");
  }

  const account = localKeychainAccount(workspaceId, service);
  return {
    account,
    entry: new Entry(KEYCHAIN_SERVICE, account),
  };
}

async function readBody(req: IncomingMessage): Promise<CredentialBody> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(raw) as CredentialBody;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed;
}

function isAuthorized(req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${token}`;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = randomUUID();
  const url = new URL(req.url || "/", `http://${bindHost}:${port}`);

  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { status: "ok", workspaceId });
    return;
  }

  if (!isAuthorized(req)) {
    writeJson(res, 401, { error: "Unauthorized" });
    return;
  }

  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readBody(req);

    if (url.pathname === "/credentials/get") {
      const { entry, account } = credentialEntry(body.service);
      writeJson(res, 200, {
        apiKey: entry.getPassword(),
        keychainAccount: account,
      });
      return;
    }

    if (url.pathname === "/credentials/set") {
      if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
        writeJson(res, 400, { error: "API key is required." });
        return;
      }

      const apiKey = body.apiKey.trim();
      const { entry, account } = credentialEntry(body.service);
      entry.setPassword(apiKey);
      writeJson(res, 200, { keychainAccount: account });
      return;
    }

    if (url.pathname === "/credentials/delete") {
      const { entry } = credentialEntry(body.service);
      writeJson(res, 200, { deleted: entry.deletePassword() });
      return;
    }

    writeJson(res, 404, { error: "Not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Keychain bridge failed.";
    console.warn({ requestId, err }, "Local keychain bridge request failed");
    writeJson(res, 400, { error: message, requestId });
  }
}

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((err) => {
    const message = err instanceof Error ? err.message : "Keychain bridge failed.";
    console.error({ err }, "Local keychain bridge crashed during request");
    writeJson(res, 500, { error: message });
  });
});

server.listen(port, bindHost, () => {
  console.log(
    `Local keychain bridge listening on http://${bindHost}:${port} (${workspaceId})`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
