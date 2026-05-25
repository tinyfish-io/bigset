import { completeJson } from "../integrations/openrouter.js";
import {
  memoryContextForAgents,
  type WorkflowMemory,
} from "../memory/index.js";
import { agentGoalSchema, type AgentGoal } from "../models/schemas.js";
import type { DatasetSpec, SourceTriageResult } from "../models/schemas.js";
import type { LlmMessage } from "../integrations/openrouter.js";

export const AGENT_BROWSER_ACTION_CONTRACT = `Browser action reporting contract:
- The Tinyfish Agent result JSON MUST include "agent_browser_actions" next to "records".
- "agent_browser_actions" is an ordered array of browser steps the agent actually performed.
- Each action should use this shape when known: { "action": "navigate|click|type|select|wait|extract|screenshot|unknown", "url": "current page URL", "selector": "CSS selector when known", "target_text": "visible button/link/field text when known", "value_description": "safe description of typed/selected value, never secrets", "status": "succeeded|failed", "error": "failure reason if any", "phase": "initial|search|filter|pagination|detail|form|extract", "label": "short human label" }.
- Record navigation, clicks, form fills, pagination, waits that affected extraction, and final extraction.
- If a selector is unknown, still include url plus target_text when visible. If no browser action happened, return an empty array.
- Do not include raw passwords, tokens, cookies, or private user-entered values in value_description.`;

const AGENT_GOAL_SYSTEM = `You are the Navigation Task Agent for a web data collection pipeline.

Write a Tinyfish Agent goal: a clear natural-language instruction for browser automation on the given URL.

The agent must navigate the site and return structured JSON with extracted data matching the dataset schema.

Rules:
- Be specific about what to click, search, filter, or paginate.
- State the exact JSON shape to return: { "records": [ { column_name: value, ... } ], "agent_browser_actions": [ ... ] }
- Include column names from the schema in the goal.
- Include the browser action reporting contract verbatim enough that the Tinyfish Agent knows it must report replay-oriented actions.
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
  return completeJson({
    label: `agent_goal:${options.triage.final_url}`,
    schema: agentGoalSchema,
    messages: buildAgentGoalMessages(options),
  });
}

export function buildAgentGoalMessages(options: {
  userPrompt: string;
  spec: DatasetSpec;
  triage: SourceTriageResult;
  focusFields?: string[];
  memory?: WorkflowMemory;
}): LlmMessage[] {
  const columnList = options.spec.columns
    .map((c) => `${c.name} (${c.type}${c.required ? ", required" : ""})`)
    .join(", ");

  return [
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
        browser_action_reporting_contract: AGENT_BROWSER_ACTION_CONTRACT,
        workflow_memory: options.memory
          ? memoryContextForAgents(options.memory)
          : undefined,
        output_shape: { goal: "string", rationale: "string" },
      }),
    },
  ];
}
