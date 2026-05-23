import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createEmptyCollectionMemory,
  latestTinyfishEmittedProcess,
  loadCollectionMemory,
  recordAgentVisitedUrl,
  saveCollectionMemory,
} from "../src/pipeline/collection-memory/index.js";
import { extractEmittedProcessFromAgentResult } from "../src/pipeline/populate-browser-agent.js";

test("collection memory persists agent visits with emitted process", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "bigset-memory-"));
  try {
    let memory = createEmptyCollectionMemory({
      datasetId: "dataset-test",
      userPrompt: "Top AI companies",
    });

    memory = recordAgentVisitedUrl(memory, {
      url: "https://openai.com/about",
      provider: "tinyfish",
      goal: "Extract company fields",
      run: {
        run_id: "run_123",
        status: "COMPLETED",
        result: {
          emitted_process: {
            steps: [{ action: "click", selector: "#about" }],
          },
          summary: "done",
        },
        error: null,
      },
    });

    await saveCollectionMemory(memoryDir, memory);
    const loaded = await loadCollectionMemory(memoryDir, "dataset-test");
    assert.ok(loaded);
    assert.equal(loaded.agent_visited_urls.length, 1);
    assert.equal(loaded.agent_visited_urls[0]?.provider, "tinyfish");
    assert.deepEqual(loaded.agent_visited_urls[0]?.emitted_process, {
      steps: [{ action: "click", selector: "#about" }],
    });

    const process = latestTinyfishEmittedProcess(loaded, "https://openai.com/about");
    assert.ok(process);
    assert.ok(Array.isArray((process as { steps: unknown[] }).steps));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("extractEmittedProcessFromAgentResult falls back to full result", () => {
  const extracted = extractEmittedProcessFromAgentResult({
    answer: "42",
    nested: { ok: true },
  });
  assert.deepEqual(extracted, { answer: "42", nested: { ok: true } });
});

test("collection memory file is written per dataset id", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "bigset-memory-"));
  try {
    const memory = createEmptyCollectionMemory({
      datasetId: "dataset-abc",
      userPrompt: "prompt",
    });
    await saveCollectionMemory(memoryDir, memory);
    const raw = await readFile(join(memoryDir, "dataset-abc.json"), "utf8");
    const parsed = JSON.parse(raw) as { dataset_id: string; repair_loop: { status: string } };
    assert.equal(parsed.dataset_id, "dataset-abc");
    assert.equal(parsed.repair_loop.status, "idle");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
