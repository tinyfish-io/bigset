import assert from "node:assert/strict";
import { test } from "node:test";

import { tinyfishAgentRunResultFromRun } from "../BigSet_Data_Collection_Agent/src/integrations/tinyfish-agent.js";

test("TinyFish run normalization keeps safe provenance without streaming URL", () => {
  const normalized = tinyfishAgentRunResultFromRun({
    run_id: "run-1",
    status: "COMPLETED",
    goal: "Extract rows.",
    created_at: "2026-05-23T00:00:00Z",
    started_at: "2026-05-23T00:00:01Z",
    finished_at: "2026-05-23T00:00:02Z",
    num_of_steps: 3,
    result: {
      records: [],
    },
    error: null,
    streaming_url: "STREAMING_URL_SHOULD_NOT_BE_STORED",
    recording_url: "RECORDING_URL_SHOULD_NOT_BE_STORED",
    capture_artifacts: [{
      type: "screenshot",
      url: "CAPTURE_ARTIFACT_URL_SHOULD_NOT_BE_STORED",
    }],
    browser_config: {
      proxy_enabled: true,
      proxy_country_code: null,
    },
  } as never);

  assert.equal(normalized.agent_step_count, 3);
  assert.equal(normalized.has_streaming_url, true);
  assert.equal(normalized.has_recording_url, true);
  assert.equal(normalized.capture_artifact_count, 1);
  assert.deepEqual(normalized.result_keys, ["records"]);
  assert.equal(
    JSON.stringify(normalized).includes("STREAMING_URL_SHOULD_NOT_BE_STORED"),
    false
  );
  assert.equal(
    JSON.stringify(normalized).includes("RECORDING_URL_SHOULD_NOT_BE_STORED"),
    false
  );
  assert.equal(
    JSON.stringify(normalized).includes("CAPTURE_ARTIFACT_URL_SHOULD_NOT_BE_STORED"),
    false
  );
});

test("TinyFish run normalization converts documented run steps to browser actions", () => {
  const normalized = tinyfishAgentRunResultFromRun({
    run_id: "run-2",
    status: "COMPLETED",
    goal: "Extract rows.",
    created_at: "2026-05-23T00:00:00Z",
    started_at: "2026-05-23T00:00:01Z",
    finished_at: "2026-05-23T00:00:02Z",
    num_of_steps: 4,
    result: {
      records: [],
    },
    error: null,
    streaming_url: null,
    steps: [{
      type: "navigate",
      url: "https://example.com/products",
      status: "completed",
    }, {
      action: "click",
      current_url: "https://example.com/products",
      target: {
        selector: "button[data-category='tools']",
        text: "Tools",
      },
      outcome: "success",
    }, {
      type: "type",
      current_url: "https://example.com/products",
      selector: "input[name='password']",
      value: "secret-password",
      status: "completed",
    }],
  } as never);

  assert.deepEqual(normalized.browser_actions, [{
    action: "navigate",
    url: "https://example.com/products",
    selector: undefined,
    target_text: undefined,
    status: "succeeded",
    error: undefined,
    phase: "agent-step",
    label: "navigate",
    value_description: undefined,
  }, {
    action: "click",
    url: "https://example.com/products",
    selector: "button[data-category='tools']",
    target_text: "Tools",
    status: "succeeded",
    error: undefined,
    phase: "agent-step",
    label: undefined,
    value_description: undefined,
  }, {
    action: "fill",
    url: "https://example.com/products",
    selector: "input[name='password']",
    target_text: undefined,
    status: "succeeded",
    error: undefined,
    phase: "agent-step",
    label: "type",
    value_description: "redacted typed value (15 chars)",
  }]);
  assert.equal(JSON.stringify(normalized).includes("secret-password"), false);
});
