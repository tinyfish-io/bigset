# v1.5: Efficiency improvements (planned)

**Status:** v1.5.2 combined triage+extract **shipped**. v1.5.1 async two-call was reverted (latency-only). Revert combined: `ENABLE_COMBINED_TRIAGE_EXTRACT=false`.

v1.5 targets **LLM token cost** (primary) and wall-clock time without regressing v1.4 row quality.

---

## Proposed themes

### 1. Combined triage + extract — **shipped (v1.5.2)**

See [v15-02-combined-triage-extract.md](v15-02-combined-triage-extract.md).

- One LLM call per page: `{ triage_results, extraction_results }`.
- `source_outcomes_{phase}.json` per-source triage + inline extraction.
- Default `TRIAGE_CONCURRENCY=10`, 2× page chars for combined agent.

### 2. Task-scoped workflow memory

- Replace one `memoryContextForAgents()` blob with **per-role** slices (triage vs extract vs agent-goal vs repair).
- Drop `query_stats.page_breakdown` from agent prompts; pass **domain-scoped** stats where helpful.
- Largest token savings on high page-count phases.

### 3. Outcome-based Tinyfish Agent

- Today: `requires_*` triage → agent queue (no direct extract first).
- Proposed: after direct extract + merge, run agents only if **complete required rows** &lt; target (with triage + cheap-extract gates).
- Requires clearer metrics than raw `records_from_extract` (dedupe collapses many rows).

### 4. Priority-ordered extract and agent queues

- Sort pages by `source_data_confidence`, triage confidence, `domainMemoryBoost`.
- Optional early exit when complete rows ≥ target (with minimum page floor).

### 5. Adaptive agent polling

- Avoid flat **30s** poll interval (adds ~15s average lag per run).
- Proposed: 3s early, backoff to 10–30s, or 30s only for large batches.

---

## Success metrics

Compare v1.4 vs v1.5 on the same `prompts.json` subset:

| Metric | Source |
|--------|--------|
| `duration_ms` | `run_report.json` |
| `llm_usage.total_tokens` | `run_report.json` |
| `visualization_records` / complete count | `run_report.json`, `quality_report.json` |
| Tinyfish agent dispatches | `stats.triage.agent_dispatched` |

Quality must not drop systematically on the 4 “good” benchmark prompts.

---

## References

- Architecture discussion (conversation): efficiency tradeoffs per proposal.
- [data-flow.md](data-flow.md) — current stage contracts unchanged until v1.5 ships.
