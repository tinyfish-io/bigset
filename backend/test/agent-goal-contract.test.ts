import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_BROWSER_ACTION_CONTRACT,
  buildAgentGoalMessages,
} from "../BigSet_Data_Collection_Agent/src/agents/agent-goal.js";

test("Agent goal prompt requires producer-side browser action reporting", () => {
  const messages = buildAgentGoalMessages({
    userPrompt: "Find SaaS pricing pages.",
    spec: {
      intent_summary: "Find pricing pages.",
      target_row_count: 3,
      row_grain: "company",
      columns: [
        {
          name: "company_name",
          type: "string",
          description: "Company name",
          required: true,
        },
        {
          name: "pricing_url",
          type: "string",
          description: "Pricing page URL",
          required: true,
        },
      ],
      dedupe_keys: ["company_name"],
      search_queries: ["SaaS pricing"],
      extraction_hints: "Prefer official pricing pages.",
    },
    triage: {
      url: "https://example.com",
      final_url: "https://example.com/pricing",
      title: "Pricing",
      status: "requires_navigation",
      confidence: 0.9,
      source_data_confidence: 0.8,
      expected_yield: "partial",
      reasoning: "Needs click-through navigation.",
      suggested_action: "Open pricing details.",
    },
  });

  const systemPrompt = messages.find((message) => message.role === "system")
    ?.content ?? "";
  const userPayload = JSON.parse(
    messages.find((message) => message.role === "user")?.content ?? "{}"
  );

  assert.match(systemPrompt, /agent_browser_actions/);
  assert.match(systemPrompt, /records/);
  assert.match(AGENT_BROWSER_ACTION_CONTRACT, /selector/);
  assert.match(AGENT_BROWSER_ACTION_CONTRACT, /target_text/);
  assert.match(AGENT_BROWSER_ACTION_CONTRACT, /value_description/);
  assert.equal(
    userPayload.browser_action_reporting_contract,
    AGENT_BROWSER_ACTION_CONTRACT
  );
});
