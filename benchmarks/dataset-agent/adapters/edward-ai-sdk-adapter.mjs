#!/usr/bin/env node
import { spawn } from "node:child_process";

const execution = await runCommand("npm", [
  "--prefix",
  "backend",
  "run",
  "dataset-agent:benchmark",
]);

if (execution.stderr) {
  process.stderr.write(execution.stderr);
}
process.stdout.write(execution.stdout);
process.exitCode = execution.exitCode;

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
  });
}
