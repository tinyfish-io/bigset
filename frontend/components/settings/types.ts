export interface OpenRouterModel {
  modelName: string;
  canonicalSlug: string;
  contextLength: number;
  promptCost: number;
  completionCost: number;
}

export interface ModelRole {
  key: string;
  label: string;
  description: string;
}

export const MODEL_ROLES: ModelRole[] = [
  { key: "schemaInference", label: "Schema Inference", description: "Used to generate dataset schema from natural language" },
  { key: "populateOrchestrator", label: "Populate Orchestrator", description: "Coordinates row population workflow" },
  { key: "investigateSubagent", label: "Investigate Subagent", description: "Researches individual entities" },
];