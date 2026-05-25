import { readFile } from "node:fs/promises";

import {
  populateRuntimePrerequisiteError,
  type PopulateRuntimePrerequisites,
} from "./populate-runtime-prerequisites.js";
import { datasetContextSchema, type DatasetContext } from "./populate.js";
import { InMemoryPopulateRecipeStore } from "./populate-self-healing.js";
import {
  runSelfHealingPopulate,
  type PopulateDatasetRowWriter,
  type RunSelfHealingPopulateResult,
} from "./populate-self-healing-runner.js";
import {
  createPopulateRecipeRuntime,
  type CreatePopulateRecipeRuntimeInput,
} from "./populate-runtime-selection.js";

export const DEFAULT_COMMIT_ROW_LIMIT_PER_HOUR = 1000;

export interface PopulateSelfHealingCliOptions {
  datasetId?: string;
  contextPath?: string;
  shouldReadStdin: boolean;
  shouldCommitRows: boolean;
  recipeStoreDirectory?: string;
  maxRows?: number;
  commitRowLimitPerHour?: number;
}

export interface PopulateSelfHealingCliDependencies {
  argv: string[];
  env: NodeJS.ProcessEnv;
  readFileText?: (path: string) => Promise<string>;
  readStdinText?: () => Promise<string>;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  runSelfHealing?: typeof runSelfHealingPopulate;
  createRuntime?: (
    input: CreatePopulateRecipeRuntimeInput
  ) => Promise<Awaited<ReturnType<typeof createPopulateRecipeRuntime>>>;
  loadDatasetContextById?: (datasetId: string) => Promise<DatasetContext>;
  createRowWriter?: () => Promise<PopulateDatasetRowWriter>;
}

export async function runPopulateSelfHealingCli(
  input: PopulateSelfHealingCliDependencies
): Promise<number> {
  const writeStdout = input.writeStdout ?? ((text) => console.log(text));
  const writeStderr = input.writeStderr ?? ((text) => console.error(text));

  try {
    const options = parsePopulateSelfHealingCliArgs(input.argv);
    const prerequisiteError = populateRuntimePrerequisiteError(
      prerequisitesFromEnv({
        env: input.env,
        shouldCommitRows: options.shouldCommitRows,
        shouldLoadDatasetContext: Boolean(options.datasetId),
      })
    );
    if (prerequisiteError) {
      writeStdout(JSON.stringify({
        success: false,
        error: prerequisiteError,
        dryRun: !options.shouldCommitRows,
      }));
      return 1;
    }

    const context = await resolveDatasetContext({
      options,
      readFileText: input.readFileText ?? ((path) => readFile(path, "utf8")),
      readStdinText: input.readStdinText ?? readProcessStdin,
      loadDatasetContextById:
        input.loadDatasetContextById ??
        ((datasetId) => defaultLoadDatasetContextById(datasetId, input.env)),
    });
    const runtime = await (input.createRuntime ?? createPopulateRecipeRuntime)({
      env: input.env,
      maxRows: options.maxRows,
    });
    const rowWriter = options.shouldCommitRows
      ? await (input.createRowWriter ?? defaultCreateRowWriter)()
      : undefined;
    const result = await (input.runSelfHealing ?? runSelfHealingPopulate)({
      context,
      store: options.shouldCommitRows
        ? undefined
        : new InMemoryPopulateRecipeStore(),
      recipeStoreDirectory: options.shouldCommitRows
        ? options.recipeStoreDirectory ?? input.env.POPULATE_RECIPE_STORE_DIR
        : undefined,
      rowWriter,
      shouldCommitRows: options.shouldCommitRows,
      runtime,
      commitRowLimit: options.shouldCommitRows
        ? {
          maxRowsPerWindow: commitRowLimitPerHour({
            optionValue: options.commitRowLimitPerHour,
            envValue: input.env.POPULATE_COMMIT_ROW_LIMIT_PER_HOUR,
          }),
          windowMs: 60 * 60 * 1_000,
        }
        : undefined,
    });

    writeStdout(JSON.stringify(summaryForResult(result, !options.shouldCommitRows)));
    return result.success ? 0 : 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(message);
    writeStdout(JSON.stringify({ success: false, error: message }));
    return 1;
  }
}

export function parsePopulateSelfHealingCliArgs(
  argv: string[]
): PopulateSelfHealingCliOptions {
  const options: PopulateSelfHealingCliOptions = {
    shouldReadStdin: false,
    shouldCommitRows: false,
  };
  const contextSources: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--context" || arg === "--context-file") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a file path or "-".`);
      }
      options.contextPath = value;
      options.shouldReadStdin = value === "-";
      contextSources.push(arg);
      index += 1;
    } else if (arg === "--stdin") {
      options.shouldReadStdin = true;
      options.contextPath = "-";
      contextSources.push(arg);
    } else if (arg === "--dataset-id") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--dataset-id requires a dataset id.");
      }
      options.datasetId = value;
      contextSources.push(arg);
      index += 1;
    } else if (arg === "--commit") {
      options.shouldCommitRows = true;
    } else if (arg === "--recipe-store-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--recipe-store-dir requires a directory path.");
      }
      options.recipeStoreDirectory = value;
      index += 1;
    } else if (arg === "--max-rows") {
      const value = argv[index + 1];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--max-rows requires a positive integer.");
      }
      options.maxRows = parsed;
      index += 1;
    } else if (arg === "--commit-row-limit-per-hour") {
      const value = argv[index + 1];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--commit-row-limit-per-hour requires a positive integer.");
      }
      options.commitRowLimitPerHour = parsed;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (contextSources.length === 0) {
    throw new Error("Missing --dataset-id <id>, --context <file>, or --stdin.");
  }
  if (contextSources.length > 1) {
    throw new Error(
      `Choose exactly one context source: ${contextSources.join(", ")}.`
    );
  }
  if (!options.shouldCommitRows && options.recipeStoreDirectory) {
    throw new Error("--recipe-store-dir requires --commit.");
  }
  return options;
}

async function resolveDatasetContext(input: {
  options: PopulateSelfHealingCliOptions;
  readFileText: (path: string) => Promise<string>;
  readStdinText: () => Promise<string>;
  loadDatasetContextById: (datasetId: string) => Promise<DatasetContext>;
}): Promise<DatasetContext> {
  if (input.options.datasetId) {
    return input.loadDatasetContextById(input.options.datasetId);
  }
  const text = input.options.shouldReadStdin
    ? await input.readStdinText()
    : await input.readFileText(input.options.contextPath!);
  return datasetContextSchema.parse(JSON.parse(text));
}

function prerequisitesFromEnv(input: {
  env: NodeJS.ProcessEnv;
  shouldCommitRows: boolean;
  shouldLoadDatasetContext: boolean;
}): PopulateRuntimePrerequisites {
  return {
    convexUrl: input.env.CONVEX_URL,
    convexAdminKey: input.env.CONVEX_SELF_HOSTED_ADMIN_KEY,
    openRouterApiKey: input.env.OPENROUTER_API_KEY,
    tinyFishApiKey: input.env.TINYFISH_API_KEY,
    shouldCommitRows: input.shouldCommitRows,
    shouldLoadDatasetContext: input.shouldLoadDatasetContext,
  };
}

async function defaultLoadDatasetContextById(
  datasetId: string,
  env: NodeJS.ProcessEnv
): Promise<DatasetContext> {
  const { createConvexPopulateDatasetContextLoader } = await import(
    "./populate-dataset-context-loader.js"
  );
  const loader = createConvexPopulateDatasetContextLoader({
    convexUrl: env.CONVEX_URL!,
    convexAdminKey: env.CONVEX_SELF_HOSTED_ADMIN_KEY!,
  });
  return loader.loadContext(datasetId);
}

async function defaultCreateRowWriter(): Promise<PopulateDatasetRowWriter> {
  const { ConvexPopulateDatasetRowWriter } = await import(
    "./populate-convex-writer.js"
  );
  return new ConvexPopulateDatasetRowWriter();
}

function summaryForResult(
  result: RunSelfHealingPopulateResult,
  isDryRun: boolean
) {
  const diagnosticRun = result.selectedRun ?? result.diagnosticRun;
  return {
    success: result.success,
    dryRun: isDryRun,
    action: result.action,
    datasetId: result.datasetId,
    committedRows: result.committedRows,
    commitLimit: result.commitLimit,
    rowCount: diagnosticRun?.rows.length ?? 0,
    validationIssues: result.validationIssues,
    rejectionReasons: result.rejectionReasons,
    productionValidation: diagnosticRun?.productionValidation,
    metrics: diagnosticRun?.metrics,
  };
}

function commitRowLimitPerHour(input: {
  optionValue?: number;
  envValue?: string;
}): number {
  if (input.optionValue !== undefined) {
    return input.optionValue;
  }
  if (input.envValue === undefined || input.envValue === "") {
    return DEFAULT_COMMIT_ROW_LIMIT_PER_HOUR;
  }
  const parsed = Number(input.envValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "POPULATE_COMMIT_ROW_LIMIT_PER_HOUR must be a positive integer."
    );
  }
  return parsed;
}

async function readProcessStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
  }
  return text;
}
