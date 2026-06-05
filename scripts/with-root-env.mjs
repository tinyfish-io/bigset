#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootEnvPath = resolve(repoRoot, ".env");
const childPidFile = process.env.WITH_ROOT_ENV_CHILD_PID_FILE
  ? resolve(repoRoot, process.env.WITH_ROOT_ENV_CHILD_PID_FILE)
  : null;

if (existsSync(rootEnvPath)) {
  for (const line of readFileSync(rootEnvPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

const childEnv = { ...process.env };
delete childEnv.WITH_ROOT_ENV_CHILD_PID_FILE;

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/with-root-env.mjs <command> [...args]");
  process.exit(2);
}

const child = spawn(command, args, {
  env: childEnv,
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (childPidFile && child.pid) {
  mkdirSync(dirname(childPidFile), { recursive: true });
  writeFileSync(childPidFile, `${child.pid}\n`);
}

let forwardingSignal = null;
const signalHandlers = new Map();

function childHasExited() {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit() {
  if (childHasExited()) return Promise.resolve();
  return new Promise((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
}

function exitWithSignal(signal) {
  for (const [registeredSignal, handler] of signalHandlers) {
    process.off(registeredSignal, handler);
  }
  process.kill(process.pid, signal);
}

async function forwardSignal(signal) {
  if (forwardingSignal) return;
  forwardingSignal = signal;
  if (!childHasExited()) child.kill(signal);
  await waitForChildExit();
  exitWithSignal(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  const handler = () => {
    void forwardSignal(signal);
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

child.on("exit", (code, signal) => {
  if (forwardingSignal) return;
  if (signal) {
    exitWithSignal(signal);
    return;
  }
  process.exit(code ?? 1);
});
