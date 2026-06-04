#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendDir = join(repoRoot, "frontend");
const backendDir = join(repoRoot, "backend");
const distDir = join(repoRoot, "dist");
const workDir = join(distDir, "release-work");
const packageRoot = join(workDir, "bigset");
const artifactPath = join(distDir, "bigset-build.zip");
const sizeLimitBytes = 50 * 1024 * 1024;
const convexRuntimePackages = ["convex", "esbuild", "@esbuild", "prettier", "ws"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function assertExists(path, message) {
  if (!existsSync(path)) {
    throw new Error(message);
  }
}

async function fileSize(path) {
  return (await stat(path)).size;
}

function formatBytes(bytes) {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB`;
}

async function writeStartScript() {
  await writeFile(
    join(packageRoot, "start.mjs"),
    `#!/usr/bin/env node
import { spawn } from "node:child_process";

const root = new URL(".", import.meta.url);
const backendPort = process.env.BIGSET_BACKEND_PORT || "3501";
const frontendPort = process.env.BIGSET_FRONTEND_PORT || "3500";
const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || \`http://127.0.0.1:\${backendPort}\`;
const frontendUrl = \`http://127.0.0.1:\${frontendPort}\`;
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL || process.env.CONVEX_URL || "http://127.0.0.1:3210";

const children = [];

function start(name, command, args, env, cwd) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.on("data", (chunk) => process.stdout.write(\`[\${name}] \${chunk}\`));
  child.stderr.on("data", (chunk) => process.stderr.write(\`[\${name}] \${chunk}\`));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(\`\\n\${name} exited unexpectedly\${signal ? \` with signal \${signal}\` : \` with code \${code}\`}\`);
    shutdown(code ?? 1);
  });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 250).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start(
  "backend",
  process.execPath,
  [new URL("./backend/backend.mjs", root).pathname],
  {
    ...process.env,
    PORT: backendPort,
    CLIENT_ORIGIN: frontendUrl,
    CONVEX_URL: convexUrl,
    NEXT_PUBLIC_CONVEX_URL: convexUrl,
    NEXT_PUBLIC_BACKEND_URL: backendUrl,
    BIGSET_SKIP_CONVEX_STARTUP: "1",
    REFRESH_SCHEDULER_ENABLED: process.env.REFRESH_SCHEDULER_ENABLED ?? "false",
  },
  new URL("./backend", root).pathname,
);

start(
  "frontend",
  process.execPath,
  [new URL("./frontend/server.js", root).pathname],
  {
    ...process.env,
    PORT: frontendPort,
    HOSTNAME: process.env.HOSTNAME || "127.0.0.1",
    NEXT_PUBLIC_BACKEND_URL: backendUrl,
    NEXT_PUBLIC_CONVEX_URL: convexUrl,
    NEXT_PUBLIC_PROD: process.env.NEXT_PUBLIC_PROD || "",
    PROD: process.env.PROD || "",
  },
  new URL("./frontend", root).pathname,
);

console.log("");
console.log("BigSet release build is starting.");
console.log(\`  App:     \${frontendUrl}\`);
console.log(\`  Backend: \${backendUrl}\`);
console.log(\`  Convex:  \${convexUrl}\`);
console.log("");
console.log("Convex is provided by the CLI launcher or another local Convex process.");
console.log("Press Ctrl+C to stop.");
`,
    { mode: 0o755 },
  );
}

async function writeReadme() {
  await writeFile(
    join(packageRoot, "README.txt"),
    `BigSet local release build

Run:
  node start.mjs

Ports:
  App:     http://127.0.0.1:3500
  Backend: http://127.0.0.1:3501

Overrides:
  BIGSET_FRONTEND_PORT=4500 BIGSET_BACKEND_PORT=4501 node start.mjs

This artifact does not bundle the Convex binary. Start it with the BigSet CLI,
or run Convex locally and set CONVEX_URL/NEXT_PUBLIC_CONVEX_URL. The Convex app
source and CLI runtime are included so the BigSet CLI can deploy functions to a
fresh local Convex backend.
`,
  );
}

async function copyConvexRuntime() {
  await cp(join(frontendDir, "convex"), join(packageRoot, "frontend", "convex"), {
    recursive: true,
  });

  for (const packageName of convexRuntimePackages) {
    const source = join(frontendDir, "node_modules", packageName);
    if (!existsSync(source)) continue;
    await cp(source, join(packageRoot, "frontend", "node_modules", packageName), {
      recursive: true,
    });
  }
}

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await rm(artifactPath, { force: true });
  await mkdir(join(packageRoot, "backend"), { recursive: true });
  await mkdir(join(packageRoot, "frontend"), { recursive: true });

  console.log("Building frontend standalone output...");
  run("npm", ["run", "build"], {
    cwd: frontendDir,
    env: {
      NEXT_PUBLIC_BACKEND_URL: "http://127.0.0.1:3501",
      NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
      NEXT_PUBLIC_PROD: "",
      PROD: "",
    },
  });

  console.log("Bundling backend...");
  run(
    join(backendDir, "node_modules", ".bin", "esbuild"),
    [
      "src/index.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node22",
      `--outfile=${join(packageRoot, "backend", "backend.mjs")}`,
      `--banner:js=import { createRequire as __bigsetCreateRequire } from "node:module"; const require = __bigsetCreateRequire(import.meta.url);`,
      "--packages=bundle",
      "--log-level=warning",
    ],
    { cwd: backendDir },
  );

  const standaloneDir = join(frontendDir, ".next", "standalone");
  await assertExists(
    standaloneDir,
    "Next standalone output was not found. Make sure frontend/next.config.ts has output: \"standalone\".",
  );

  console.log("Assembling release directory...");
  await cp(standaloneDir, join(packageRoot, "frontend"), { recursive: true });
  await cp(join(frontendDir, "public"), join(packageRoot, "frontend", "public"), {
    recursive: true,
  });
  await cp(
    join(frontendDir, ".next", "static"),
    join(packageRoot, "frontend", ".next", "static"),
    { recursive: true },
  );
  await copyConvexRuntime();
  await writeStartScript();
  await writeReadme();

  console.log("Creating zip artifact...");
  run("zip", ["-qry", "-9", artifactPath, "bigset"], { cwd: workDir });

  const artifactSize = await fileSize(artifactPath);
  console.log("");
  console.log(`Artifact: ${artifactPath}`);
  console.log(`Size:     ${formatBytes(artifactSize)}`);
  if (artifactSize > sizeLimitBytes) {
    console.warn(
      `Warning: artifact is above the ${formatBytes(sizeLimitBytes)} target.`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
