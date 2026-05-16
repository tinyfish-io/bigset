export type DatasetColumnKind =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "url"
  | "json";

export type DatasetUpdateCadence = "manual" | "hourly" | "daily" | "weekly";

export type DatasetSourceStrategy =
  | "search_fetch"
  | "search_fetch_browser"
  | "browser_form_fill";

export type DatasetPlanningMode = "deterministic" | "openrouter";

export interface DatasetColumnDefinition {
  name: string;
  kind: DatasetColumnKind;
  description: string;
  isRequired: boolean;
  isIdentity?: boolean;
  sourceHint?: string;
}

export interface DatasetSchema {
  datasetName: string;
  identityColumnName: string;
  columns: DatasetColumnDefinition[];
}

export interface ClarifyingQuestion {
  id: string;
  question: string;
  reason: string;
  appliesTo?: string;
}

export interface DatasetBuildRequest {
  userRequest: string;
  updateCadence?: DatasetUpdateCadence;
  providedInputs?: Record<string, string>;
  preferredColumns?: string[];
  planningMode?: DatasetPlanningMode;
}

export interface AgentHarnessStage {
  id: string;
  title: string;
  purpose: string;
  tool: "user_input" | "tinyfish_search" | "tinyfish_fetch" | "tinyfish_agent" | "validator" | "database";
  canRunWithoutUser: boolean;
}

export interface DatasetBuildPlan {
  datasetName: string;
  userRequest: string;
  updateCadence: DatasetUpdateCadence;
  schema: DatasetSchema;
  sourceStrategy: DatasetSourceStrategy;
  clarifyingQuestions: ClarifyingQuestion[];
  harnessStages: AgentHarnessStage[];
  validationRules: string[];
  replacementPolicy: string;
  nextActions: string[];
  plannerWarnings: string[];
  createdAt: string;
}

export interface DatasetRunCell {
  columnName: string;
  value: string | number | boolean | null;
  sourceUrl?: string;
  confidenceScore: number;
  validationStatus: "valid" | "missing" | "needs_review";
}

export interface DatasetRunRow {
  identityValue: string;
  cells: DatasetRunCell[];
}

export interface DatasetRunArtifact {
  planId?: string;
  rows: DatasetRunRow[];
  sourceUrls: string[];
  missingInputs: ClarifyingQuestion[];
  validationIssues: string[];
  completedAt?: string;
}
