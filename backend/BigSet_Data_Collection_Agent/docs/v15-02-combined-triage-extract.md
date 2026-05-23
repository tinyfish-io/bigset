# v1.5.2 — Combined triage + extract (shipped)

**Status:** Implemented. Default in code; revert with `ENABLE_COMBINED_TRIAGE_EXTRACT=false`.

## Goal

Reduce **LLM tokens** on `extract_now` pages by replacing two calls (`triagePage` + `extractFromPage`) with **one** combined call that reuses the same page markdown and spec context.

## Behavior (unchanged routing)

| Status | Combined call | Pipeline |
|--------|---------------|----------|
| `extract_now` | `triage_results` + `extraction_results` | Records merged; memory attributed via triage + records |
| `requires_*` | `triage_results` only (`records: []`) | Tinyfish agent → `extract-from-agent` |
| Other | `triage_results` only | Skip |
| Agent disabled + `requires_*` | Triage only in combined call | **Fallback** `extractFromPage` (same as v1.4) |

## Per-source tracking

`source_outcomes_{phase}.json` — array of:

```json
{
  "url": "...",
  "final_url": "...",
  "triage_results": { "status": "extract_now", "..." },
  "extraction_results": { "records": [...], "notes": "..." }
}
```

`extraction_results` is `null` when no inline extract (e.g. `requires_navigation`).

`triage_{phase}.json` is still written (list of `triage_results` only) for tools and memory that expect the prior shape.

## Configuration

```env
ENABLE_COMBINED_TRIAGE_EXTRACT=true   # default
TRIAGE_EXTRACT_MAX_PAGE_CHARS=24000 # default 2 × MAX_PAGE_CHARS
TRIAGE_CONCURRENCY=10                 # default (was 5)
```

## Files

- `src/agents/triage-extract.ts` — `triageAndExtractPage`, `buildTriageExtractCombinedSchema`
- `src/orchestrator/process-pages.ts` — combined vs legacy paths, `source_outcomes_*` artifact
- `src/agents/source-triage.ts` — legacy triage-only (unchanged)
- `src/agents/extract.ts` — finalize + legacy/fallback extract

## Revert

Set `ENABLE_COMBINED_TRIAGE_EXTRACT=false` to restore v1.4 batched triage then separate extract (no `source_outcomes` inline records from combined call).
