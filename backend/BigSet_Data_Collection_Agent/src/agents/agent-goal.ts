import { completeJson } from "../integrations/openrouter.js";
import {
  memoryContextForAgents,
  type WorkflowMemory,
} from "../memory/index.js";
import { agentGoalSchema, type AgentGoal } from "../models/schemas.js";
import type { DatasetSpec, SourceTriageResult } from "../models/schemas.js";

const AGENT_GOAL_SYSTEM = `You are the Navigation Task Agent for a web data collection pipeline.

Write a Tinyfish Agent goal: a clear natural-language instruction for browser automation on the given URL.

The agent must navigate the site and return structured JSON with extracted data matching the dataset schema.

Rules:
- Be specific about what to click, search, filter, or paginate.
- State the exact JSON shape to return: { "records": [ { column_name: value, ... } ] }
- Include column names from the schema in the goal.
- For forms: describe fields to fill and how to submit.
- For detail follow-up: explain how to open each item and which fields to collect.
- Limit scope (e.g. first 25 rows) to keep runs reliable.
- Do not invent data; extract only what is visible on the site.
- When workflow_memory is provided, reuse goal patterns from agent_goal_stats_top (high avg_completeness/confidence); avoid domains in domain_stats_weak unless diagnosis says otherwise.
- If latest_diagnosis.prefer_tinyfish_agent or agent_strategy_notes exist, follow them.
- Return ONLY JSON with fields: goal, rationale`;

export async function generateAgentGoal(options: {
  userPrompt: string;
  spec: DatasetSpec;
  triage: SourceTriageResult;
  focusFields?: string[];
  memory?: WorkflowMemory;
}): Promise<AgentGoal> {
  const columnList = options.spec.columns
    .map((c) => `${c.name} (${c.type}${c.required ? ", required" : ""})`)
    .join(", ");

  return completeJson({
    label: `agent_goal:${options.triage.final_url}`,
    schema: agentGoalSchema,
    messages: [
      { role: "system", content: AGENT_GOAL_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          user_prompt: options.userPrompt,
          triage_status: options.triage.status,
          triage_reasoning: options.triage.reasoning,
          suggested_action: options.triage.suggested_action,
          page_url: options.triage.final_url,
          page_title: options.triage.title,
          row_grain: options.spec.row_grain,
          columns: columnList,
          focus_fields: options.focusFields ?? [],
          extraction_hints: options.spec.extraction_hints,
          workflow_memory: options.memory
            ? memoryContextForAgents(options.memory)
            : undefined,
          output_shape: { goal: "string", rationale: "string" },
        }),
      },
    ],
  });
}
