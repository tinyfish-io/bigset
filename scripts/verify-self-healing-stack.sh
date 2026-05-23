#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

DATASET_ID=""
SHOULD_COMMIT_ROWS=0
SHOULD_RUN_CONVEX_PUSH=0
SHOULD_RUN_LOCAL_GATES=1
SHOULD_RUN_BLOCKED_BENCHMARK_SMOKE=1
SHOULD_RUN_REAL_BENCHMARK=0
EXIT_STATUS=0

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/verify-self-healing-stack.sh [options]

Options:
  --dataset-id <id>     Run a live self-healing populate smoke for one dataset.
  --commit              Commit rows for --dataset-id instead of dry-run.
  --convex-push         Deploy Convex functions before the live dataset smoke.
  --real-benchmark      Run a 2-prompt real Mastra benchmark. May spend API credits.
  --skip-local          Skip backend test/build/node-check gates.
  --no-blocked-smoke    Skip the no-key benchmark blocked-contract smoke.
  -h, --help            Show this help.

Default behavior runs only local checks and a no-key benchmark smoke. It does
not load secret files and does not spend OpenRouter or TinyFish credits. Live
dataset and benchmark modes require needed env vars to be exported already.
USAGE
}

mark_pass() {
  printf 'PASS  %s\n' "$1"
}

mark_fail() {
  printf 'FAIL  %s\n' "$1"
  EXIT_STATUS=1
}

mark_blocked() {
  printf 'BLOCK %s\n' "$1"
  if [[ "$EXIT_STATUS" -eq 0 ]]; then
    EXIT_STATUS=2
  fi
}

run_required_step() {
  local label="$1"
  shift

  printf 'RUN   %s\n' "$label"
  if "$@"; then
    mark_pass "$label"
  else
    mark_fail "$label"
  fi
}

require_command() {
  local command_name="$1"
  if command -v "$command_name" >/dev/null 2>&1; then
    return 0
  fi
  mark_blocked "missing command: ${command_name}"
  return 1
}

require_env_var() {
  local env_name="$1"
  if [[ -n "${!env_name:-}" ]]; then
    return 0
  fi
  mark_blocked "missing env: ${env_name}"
  return 1
}

check_docker_compose_ready() {
  require_command docker || return 1
  docker compose -f docker-compose.dev.yml ps >/dev/null 2>&1
}

check_convex_ready() {
  local convex_url="$1"
  require_command curl || return 1
  curl -sf "${convex_url%/}/version" >/dev/null 2>&1
}

run_blocked_benchmark_smoke() {
  local system_name="$1"
  local system_command="$2"
  local out_dir="benchmark-results/${system_name}-blocked-smoke-$(date +%Y%m%d-%H%M%S)"
  local stdout_file="${out_dir}/runner-stdout.json"

  mkdir -p "$out_dir"
  printf 'RUN   %s benchmark no-key blocked smoke\n' "$system_name"
  if ! env -u OPENROUTER_API_KEY -u TINYFISH_API_KEY BIGSET_BENCHMARK_SKIP_ENV_FILES=1 node benchmarks/dataset-agent/run-benchmark.mjs \
    --prompt-ids latest-ai-blog-posts \
    --timeout-ms 60000 \
    --out "$out_dir" \
    --system "${system_name}=${system_command}" \
    > "$stdout_file"; then
    mark_fail "${system_name} benchmark no-key blocked smoke"
    return
  fi

  if node -e '
const fs = require("fs");
const summary = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const group = summary.aggregate?.[0];
if (!group || group.total !== 1 || group.blocked !== 1 || group.failed !== 0) {
  console.error("expected exactly one blocked benchmark result");
  process.exit(1);
}
const aggregateSpendFields = [
  "totalRows",
  "totalPromptTokens",
  "totalCompletionTokens",
  "totalTokens",
  "searchCallCount",
  "fetchCallCount",
  "browserCallCount",
  "agentRunCount",
  "agentStepCount",
  "estimatedTotalCostUsd",
];
const nonZeroAggregateFields = aggregateSpendFields.filter(
  (field) => Number(group[field] ?? 0) !== 0
);
if (nonZeroAggregateFields.length > 0) {
  console.error(`expected zero spend/calls for blocked smoke: ${nonZeroAggregateFields.join(", ")}`);
  process.exit(1);
}
for (const result of summary.laneResults ?? []) {
  const laneSpendFields = [
    ["rowCount", result.rowCount],
    ["promptTokens", result.usage?.promptTokens],
    ["completionTokens", result.usage?.completionTokens],
    ["totalTokens", result.usage?.totalTokens],
    ["searchCallCount", result.searchCallCount],
    ["fetchCallCount", result.fetchCallCount],
    ["browserCallCount", result.browserCallCount],
    ["agentRunCount", result.agentRunCount],
    ["agentStepCount", result.agentStepCount],
    ["estimatedTotalCostUsd", result.estimatedTotalCostUsd],
  ];
  const nonZeroLaneFields = laneSpendFields
    .filter(([, value]) => Number(value ?? 0) !== 0)
    .map(([field]) => field);
  if (nonZeroLaneFields.length > 0) {
    console.error(`expected zero spend/calls for blocked lane: ${nonZeroLaneFields.join(", ")}`);
    process.exit(1);
  }
}
' "${out_dir}/summary.json"; then
    mark_pass "${system_name} benchmark no-key blocked smoke (${out_dir})"
  else
    mark_fail "${system_name} benchmark no-key blocked smoke"
  fi
}

run_real_benchmark() {
  require_env_var OPENROUTER_API_KEY || return
  require_env_var TINYFISH_API_KEY || return

  local out_dir="benchmark-results/self-healing-real-smoke-$(date +%Y%m%d-%H%M%S)"
  local stdout_file="${out_dir}/runner-stdout.json"

  mkdir -p "$out_dir"
  printf 'RUN   mastra real benchmark smoke\n'
  if node benchmarks/dataset-agent/run-benchmark.mjs \
    --prompt-ids latest-ai-blog-posts,saas-pricing-pages \
    --timeout-ms 900000 \
    --out "$out_dir" \
    --system "mastra=node --import ./backend/node_modules/tsx/dist/esm/index.mjs benchmarks/dataset-agent/adapters/mastra-populate-adapter.mjs" \
    > "$stdout_file"; then
    mark_pass "mastra real benchmark smoke (${out_dir})"
  else
    mark_fail "mastra real benchmark smoke"
  fi
}

run_live_dataset_smoke() {
  require_env_var CONVEX_URL || return
  require_env_var CONVEX_SELF_HOSTED_ADMIN_KEY || return
  require_env_var OPENROUTER_API_KEY || return
  require_env_var TINYFISH_API_KEY || return

  if ! check_convex_ready "$CONVEX_URL"; then
    mark_blocked "Convex is not reachable at ${CONVEX_URL%/}/version"
    return
  fi

  local populate_args=(--dataset-id "$DATASET_ID" --max-rows 3)
  local label="self-healing dataset smoke dry-run"
  if [[ "$SHOULD_COMMIT_ROWS" -eq 1 ]]; then
    populate_args+=(--commit)
    label="self-healing dataset smoke commit"
  fi

  run_required_step "$label" npm --silent --prefix backend run populate:self-heal -- "${populate_args[@]}"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dataset-id)
      DATASET_ID="${2:-}"
      if [[ -z "$DATASET_ID" ]]; then
        printf 'Error: --dataset-id requires a value.\n' >&2
        exit 1
      fi
      shift 2
      ;;
    --commit)
      SHOULD_COMMIT_ROWS=1
      shift
      ;;
    --convex-push)
      SHOULD_RUN_CONVEX_PUSH=1
      shift
      ;;
    --real-benchmark)
      SHOULD_RUN_REAL_BENCHMARK=1
      shift
      ;;
    --skip-local)
      SHOULD_RUN_LOCAL_GATES=0
      shift
      ;;
    --no-blocked-smoke)
      SHOULD_RUN_BLOCKED_BENCHMARK_SMOKE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Error: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$SHOULD_COMMIT_ROWS" -eq 1 && -z "$DATASET_ID" ]]; then
  printf 'Error: --commit requires --dataset-id.\n' >&2
  exit 1
fi

if [[ "$SHOULD_RUN_LOCAL_GATES" -eq 1 ]]; then
  run_required_step "backend tests" npm --prefix backend test
  run_required_step "backend build" npm --prefix backend run build
  run_required_step "mastra adapter syntax" node --check benchmarks/dataset-agent/adapters/mastra-populate-adapter.mjs
  run_required_step "collection adapter syntax" node --check benchmarks/dataset-agent/adapters/collection-self-healing-adapter.mjs
fi

if [[ "$SHOULD_RUN_BLOCKED_BENCHMARK_SMOKE" -eq 1 ]]; then
  run_blocked_benchmark_smoke \
    "mastra" \
    "node --import ./backend/node_modules/tsx/dist/esm/index.mjs benchmarks/dataset-agent/adapters/mastra-populate-adapter.mjs"
  run_blocked_benchmark_smoke \
    "collection-self-heal" \
    "node --import ./backend/node_modules/tsx/dist/esm/index.mjs benchmarks/dataset-agent/adapters/collection-self-healing-adapter.mjs"
fi

if [[ "$SHOULD_RUN_CONVEX_PUSH" -eq 1 ]]; then
  if [[ ! -f frontend/.env.local ]]; then
    mark_blocked "frontend/.env.local missing; cannot run make convex-push"
  elif ! check_docker_compose_ready; then
    mark_blocked "Docker Compose is not ready; cannot run make convex-push"
  elif ! check_convex_ready "http://127.0.0.1:3210"; then
    mark_blocked "Convex is not reachable at http://127.0.0.1:3210/version"
  else
    run_required_step "convex push" make convex-push
  fi
fi

if [[ "$SHOULD_RUN_REAL_BENCHMARK" -eq 1 ]]; then
  run_real_benchmark
fi

if [[ -n "$DATASET_ID" ]]; then
  run_live_dataset_smoke
fi

case "$EXIT_STATUS" in
  0) printf 'DONE  self-healing stack verification passed\n' ;;
  1) printf 'DONE  self-healing stack verification failed\n' ;;
  2) printf 'DONE  self-healing stack verification blocked by local prerequisites\n' ;;
esac

exit "$EXIT_STATUS"
