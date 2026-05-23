# Tinyfish emitted-process capture (guide prompt)

Use this when configuring Tinyfish Agent goals or post-processing runs so collection memory stores a **replayable process** for Edward's Playwright agent.

## Why

Collection memory stores each Tinyfish visit under `agent_visited_urls[].emitted_process`. When `POPULATE_ENABLE_PLAYWRIGHT_AGENT=true`, the populate pipeline passes that object to Playwright as `job.emitted_process`.

The normalizer (`extractEmittedProcessFromAgentResult`) looks for, in order:

1. `result.emitted_process`
2. `result.process`
3. `result.steps` / `result.actions` / `result.navigation_trace`
4. Otherwise the **entire** `result` object

## Recommended goal suffix

Append this block to agent goals built by `buildTinyfishAgentGoal` (or pass it in Tinyfish UI when testing):

```text
PROCESS CAPTURE (required for replay):
When you finish, include a JSON field `emitted_process` in your final result with:
- `version`: "1"
- `start_url`: the URL you began from
- `steps`: an ordered array of actions, each with:
  - `kind`: one of "goto" | "click" | "fill" | "wait" | "scroll" | "extract"
  - `selector`: stable CSS selector or aria role locator when applicable
  - `value`: text filled or wait condition when applicable
  - `note`: short human-readable reason for the step
- `extracted_fields`: map of column name → value you believe were captured
- `final_url`: URL after navigation

Prefer stable selectors (data-testid, aria-label, role) over brittle XPath.
Do not omit `emitted_process` even if extraction succeeded early.
```

## Example `result` shape

```json
{
  "summary": "Extracted company profile from about page",
  "emitted_process": {
    "version": "1",
    "start_url": "https://example.com",
    "final_url": "https://example.com/about",
    "steps": [
      { "kind": "goto", "selector": null, "value": "https://example.com", "note": "Open homepage" },
      { "kind": "click", "selector": "a[href='/about']", "note": "Open about page" },
      { "kind": "extract", "selector": "main", "note": "Read main content" }
    ],
    "extracted_fields": {
      "company_name": "Example Inc",
      "official_website": "https://example.com"
    }
  },
  "page_text": "..."
}
```

## Playwright consumption (Edward)

Your compiler should:

1. Read `emitted_process.steps` in order.
2. Map each `kind` to Playwright calls (`page.goto`, `locator.click`, etc.).
3. Fall back to `goal` + `url` when a step is missing selectors.
4. Return a `BrowserAgentRunResult` whose `result` includes at least the text/fields `extractFromTinyfishAgentResult` needs.

## Verifying capture

After populate:

```bash
cat .bigset/collection-memory/<datasetId>.json | jq '.agent_visited_urls[-1].emitted_process'
```

You should see a structured `steps` array, not an empty object.

## Wiring into code (optional)

To bake the suffix into every populate agent goal, extend `buildTinyfishAgentGoal` in `populate-tinyfish-agent.ts`:

```typescript
const PROCESS_CAPTURE_SUFFIX = `...`; // block above

return `${baseGoal}\n\n${PROCESS_CAPTURE_SUFFIX}`;
```

Keep the suffix behind an env flag (e.g. `POPULATE_TINYFISH_CAPTURE_PROCESS=true`) if you want to A/B test token usage.

## Relationship to repair loop

When repair loop is implemented, pass `repair_loop: memory.repair_loop.current_loop` into agent goals so process snapshots are tagged by iteration. Playwright jobs already receive `repair_loop` on the extended job type.
