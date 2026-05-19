#!/usr/bin/env bash
# Verifies BigSet's authorization layer end-to-end against a running local
# stack (frontend :3500, convex :3210). Exits 0 if everything passes,
# 1 if any check fails. Designed to be safe to rerun.
#
#   bash scripts/verify-authz.sh
set -u

CONVEX="${CONVEX_URL:-http://localhost:3210}"
FRONTEND="${FRONTEND_URL:-http://localhost:3500}"
FAIL=0

run_test() {
  local label="$1"
  local result="$2"
  if [ "$result" = "PASS" ]; then
    printf "  ✓ %-58s %s\n" "$label" "PASS"
  else
    printf "  ✗ %-58s %s\n" "$label" "$result"
    FAIL=1
  fi
}

section() {
  echo ""
  echo "── $1 ──────────────────────────────────────────────────────────"
}

query() {
  curl -s "$CONVEX/api/query" -X POST -H 'Content-Type: application/json' -d "$1"
}
mutation() {
  curl -s "$CONVEX/api/mutation" -X POST -H 'Content-Type: application/json' -d "$1"
}

assert_success() {
  python3 -c "import json,sys; d=json.load(sys.stdin); print('PASS' if d.get('status')=='success' else 'FAIL: '+d.get('errorMessage','?')[:60])"
}
assert_error_contains() {
  local needle="$1"
  python3 -c "import json,sys; d=json.load(sys.stdin); print('PASS' if '$needle' in d.get('errorMessage','') else 'FAIL: '+d.get('errorMessage','?')[:80])"
}

echo "════════════════════════════════════════════════════════════════"
echo "  BigSet authorization verification"
echo "  convex=$CONVEX  frontend=$FRONTEND"
echo "════════════════════════════════════════════════════════════════"

PUB_ID=$(query '{"path":"datasets:listPublic","args":{},"format":"json"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['value'][0]['_id'])")

section "Anonymous READ — public dataset must be accessible"
run_test "anon datasets.get(public)" \
  "$(query "{\"path\":\"datasets:get\",\"args\":{\"id\":\"$PUB_ID\"},\"format\":\"json\"}" | assert_success)"
run_test "anon datasetRows.listByDataset(public)" \
  "$(query "{\"path\":\"datasetRows:listByDataset\",\"args\":{\"datasetId\":\"$PUB_ID\"},\"format\":\"json\"}" | assert_success)"
run_test "anon datasets.listPublic" \
  "$(query '{"path":"datasets:listPublic","args":{},"format":"json"}' | assert_success)"

section "Anonymous WRITES — must all be rejected"
run_test "anon datasets.listMine -> Not authenticated" \
  "$(query '{"path":"datasets:listMine","args":{},"format":"json"}' | assert_error_contains 'Not authenticated')"
run_test "anon datasets.create -> Not authenticated" \
  "$(mutation '{"path":"datasets:create","args":{"name":"x","description":"x","cadence":"daily","columns":[]},"format":"json"}' | assert_error_contains 'Not authenticated')"
run_test "anon datasets.updateStatus -> Not authenticated" \
  "$(mutation "{\"path\":\"datasets:updateStatus\",\"args\":{\"id\":\"$PUB_ID\",\"status\":\"paused\"},\"format\":\"json\"}" | assert_error_contains 'Not authenticated')"
run_test "anon datasets.remove -> Not authenticated" \
  "$(mutation "{\"path\":\"datasets:remove\",\"args\":{\"id\":\"$PUB_ID\"},\"format\":\"json\"}" | assert_error_contains 'Not authenticated')"

section "Internal mutations — must not be HTTP-callable"
for fn in insert update insertBatch; do
  run_test "datasetRows.$fn is internal" \
    "$(mutation "{\"path\":\"datasetRows:$fn\",\"args\":{},\"format\":\"json\"}" | assert_error_contains 'Could not find public function')"
done
run_test "publicSeed.seedPublicDatasets is internal" \
  "$(mutation '{"path":"publicSeed:seedPublicDatasets","args":{},"format":"json"}' | assert_error_contains 'Could not find public function')"

section "HTTP route protection"
run_test "GET /                         -> 200" \
  "$([ "$(curl -s -o /dev/null -w '%{http_code}' "$FRONTEND/")" = "200" ] && echo PASS || echo FAIL)"
run_test "GET /dataset/<public>         -> 200" \
  "$([ "$(curl -s -o /dev/null -w '%{http_code}' "$FRONTEND/dataset/$PUB_ID")" = "200" ] && echo PASS || echo FAIL)"
run_test "GET /sign-in                  -> 200" \
  "$([ "$(curl -s -o /dev/null -w '%{http_code}' "$FRONTEND/sign-in")" = "200" ] && echo PASS || echo FAIL)"
run_test "GET /dashboard (anon)         -> 307" \
  "$([ "$(curl -s -o /dev/null -w '%{http_code}' "$FRONTEND/dashboard")" = "307" ] && echo PASS || echo FAIL)"
run_test "GET /dataset/new (anon)       -> 307" \
  "$([ "$(curl -s -o /dev/null -w '%{http_code}' "$FRONTEND/dataset/new")" = "307" ] && echo PASS || echo FAIL)"

echo ""
if [ "$FAIL" = "0" ]; then
  echo "════════════════════════════════════════════════════════════════"
  echo "  ALL CHECKS PASSED ✓"
  echo "════════════════════════════════════════════════════════════════"
  exit 0
else
  echo "════════════════════════════════════════════════════════════════"
  echo "  SOME CHECKS FAILED ✗"
  echo "════════════════════════════════════════════════════════════════"
  exit 1
fi
