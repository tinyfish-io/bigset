import type {
  DatasetAgentRunInput,
  DatasetAgentRunResult,
} from "./types.js";

export type DatasetRecipeStatus =
  | "active"
  | "candidate"
  | "retired"
  | "rejected";

export type DatasetRecipeRunStatus = "succeeded" | "failed";

export type DatasetRecipeArtifactKind =
  | "stdout"
  | "stderr"
  | "screenshot"
  | "dom"
  | "text"
  | "url-history";

export interface DatasetRecipe {
  recipeId: string;
  datasetId: string;
  version: number;
  status: DatasetRecipeStatus;
  scriptText: string;
  requestedColumns: string[];
  minimumRequiredColumns: string[];
  sourcePrompt: string;
  createdAt: string;
  createdBy: "agent" | "human" | "system";
  lastSuccessfulRunAt?: string;
  lastValidationScore?: number;
}

export interface DatasetRecipeArtifact {
  kind: DatasetRecipeArtifactKind;
  label: string;
  content?: string;
  uri?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface DatasetRecipeProductionValidation {
  isValid: boolean;
  score: number;
  rowCount: number;
  minimumRequiredCompletenessRatio: number;
  requestedCellCompletenessRatio: number;
  sourceUrlCoverageRatio: number;
  evidenceCoverageRatio: number;
  criticalIssues: string[];
  warnings: string[];
}

export interface DatasetRecipeBenchmarkScore {
  score: number;
  passed: boolean;
  failureCategory?: string;
  details?: Record<string, unknown>;
}

export interface DatasetRecipeRunInput {
  recipe: DatasetRecipe;
  runInput: DatasetAgentRunInput;
}

export interface DatasetRecipeRunResult extends DatasetAgentRunResult {
  recipeId: string;
  recipeVersion: number;
  runStatus: DatasetRecipeRunStatus;
  startedAt: string;
  completedAt: string;
  runtimeMs: number;
  artifacts: DatasetRecipeArtifact[];
  productionValidation: DatasetRecipeProductionValidation;
  benchmarkScore?: DatasetRecipeBenchmarkScore;
}

export interface DatasetRecipeRuntime {
  runRecipe(input: DatasetRecipeRunInput): Promise<DatasetRecipeRunResult>;
}
