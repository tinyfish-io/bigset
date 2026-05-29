export interface OpenRouterModel {
  canonicalSlug: string;
  name: string;
  contextLength: number;
  completionCost: number;
  promptCost: number;
  provider?: string;
}

export interface ModelRole {
  key: string;
  label: string;
  description: string;
}

export const MODEL_ROLES: ModelRole[] = [
  {
    key: "schemaInference",
    label: "Schema Inference",
    description: "Used to generate dataset schema from natural language",
  },
  {
    key: "populateOrchestrator",
    label: "Populate Orchestrator",
    description: "Coordinates row population workflow",
  },
  {
    key: "investigateSubagent",
    label: "Investigate Subagent",
    description: "Researches individual entities",
  },
];

export const MOCK_MODELS: OpenRouterModel[] = [
  {
    canonicalSlug: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4",
    contextLength: 200000,
    completionCost: 0.000003,
    promptCost: 0.000004,
  },
  {
    canonicalSlug: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    contextLength: 200000,
    completionCost: 0.000015,
    promptCost: 0.000018,
  },
  {
    canonicalSlug: "qwen/qwen3.7-max",
    name: "Qwen 3.7 Max",
    contextLength: 32000,
    completionCost: 0.0000012,
    promptCost: 0.0000012,
  },
  {
    canonicalSlug: "qwen/qwen2.5-72b",
    name: "Qwen 2.5 72B",
    contextLength: 32000,
    completionCost: 0.0000009,
    promptCost: 0.0000009,
  },
  {
    canonicalSlug: "moonshotai/kimi-k2-0905",
    name: "Kimi K2",
    contextLength: 128000,
    completionCost: 0.000001,
    promptCost: 0.000001,
  },
  {
    canonicalSlug: "google/gemini-flash-2.0",
    name: "Gemini Flash 2.0",
    contextLength: 1000000,
    completionCost: 0.0000001,
    promptCost: 0.0000001,
  },
  {
    canonicalSlug: "google/gemini-pro-1.5",
    name: "Gemini Pro 1.5",
    contextLength: 2000000,
    completionCost: 0.000000125,
    promptCost: 0.000000125,
  },
  {
    canonicalSlug: "deepseek/deepseek-chat-v3",
    name: "DeepSeek Chat V3",
    contextLength: 64000,
    completionCost: 0.0000007,
    promptCost: 0.0000007,
  },
  {
    canonicalSlug: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    contextLength: 128000,
    completionCost: 0.00000015,
    promptCost: 0.0000006,
  },
  {
    canonicalSlug: "openai/gpt-4o",
    name: "GPT-4o",
    contextLength: 128000,
    completionCost: 0.0000025,
    promptCost: 0.00001,
  },
  {
    canonicalSlug: "meta-llama/llama-3-3-70b",
    name: "Llama 3.3 70B",
    contextLength: 128000,
    completionCost: 0.0000005,
    promptCost: 0.0000005,
  },
  {
    canonicalSlug: "mistral/mistral-large",
    name: "Mistral Large",
    contextLength: 128000,
    completionCost: 0.000002,
    promptCost: 0.000008,
  },
];