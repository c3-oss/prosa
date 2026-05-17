#!/usr/bin/env bash
# API-1 (combined) — Server profile during a single cold sync.
# Uses the existing smoke bundle (no re-clone). Patched CLI required.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source /tmp/prosa-perf-env

TS=$(date -u +%Y%m%dT%H%M%SZ)
RUN_DIR="bench/perf/results/${TS}-api-1"
mkdir -p "$RUN_DIR/profiles"
bash bench/perf/tools/collect-env.sh "$RUN_DIR"

CLI="apps/cli/dist/bin/prosa.js"
API="apps/api/dist/bin/prosa-api.js"
SMOKE_BUNDLE="${BUNDLE_DIR}-smoke"

if [ ! -d "$SMOKE_BUNDLE" ]; then
  echo "missing $SMOKE_BUNDLE" >&2; exit 1
fi

export PROSA_RUNTIME_MODE=production
export PROSA_API_HOST=127.0.0.1
export PROSA_API_PORT=30082
export PROSA_API_URL=http://127.0.0.1:30082
export PROSA_WEB_ORIGIN=http://localhost:5173
export PROSA_LOG_LEVEL=info
export PROSA_DATABASE_URL=postgres://prosa:prosa@127.0.0.1:55432/prosa
export PROSA_AUTH_SECRET=perf-secret-32characters-or-more-bench
export PROSA_OBJECT_STORE_DRIVER=s3
export PROSA_OBJECT_STORE_BUCKET=prosa
export PROSA_OBJECT_STORE_PREFIX=prosa/
export PROSA_OBJECT_STORE_ENDPOINT=http://127.0.0.1:19000
export PROSA_OBJECT_STORE_REGION=us-east-1
export PROSA_OBJECT_STORE_ACCESS_KEY_ID=prosa
export PROSA_OBJECT_STORE_SECRET_ACCESS_KEY=prosa-minio

# Reset pg_stat_statements.
PGPASSWORD=prosa psql -h 127.0.0.1 -p 55432 -U prosa -d prosa -c \
  "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;" 2>/dev/null || true
PGPASSWORD=prosa psql -h 127.0.0.1 -p 55432 -U prosa -d prosa -c \
  "SELECT pg_stat_statements_reset();" >/dev/null 2>&1 || true

# Start API with cpu-prof + heap-prof (no --trace-gc; NODE_OPTIONS denies it).
echo "[api-1] starting profiled API server ..."
node \
  --enable-source-maps \
  --trace-gc \
  --cpu-prof --cpu-prof-dir="$RUN_DIR/profiles" --cpu-prof-name="server.cpuprofile" --cpu-prof-interval=500 \
  --heap-prof --heap-prof-dir="$RUN_DIR/profiles" --heap-prof-name="server.heapprofile" \
  "$API" \
  > "$RUN_DIR/api.stdout.log" 2> "$RUN_DIR/api.gc.log" &
API_PID=$!
trap "kill -TERM $API_PID 2>/dev/null || true" EXIT INT TERM

for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:30082/health >/dev/null 2>&1; then
    echo "[api-1] healthy after ${i}s"
    break
  fi
  sleep 1
done

# Bootstrap auth + tenant.
CFG_DIR="$RUN_DIR/cli-config"
mkdir -p "$CFG_DIR"
export PROSA_CONFIG_PATH="$CFG_DIR/config.json"
EMAIL="api1-$(date +%s)@example.com"
PASSWORD="correct-horse-battery"
TENANT="api1-$(date +%s)"
SERVER_URL="http://127.0.0.1:30082"

echo "[api-1] signup ..."
START=$(date +%s%3N)
node --enable-source-maps "$CLI" auth signup \
  --server "$SERVER_URL" --email "$EMAIL" --password "$PASSWORD" --name "api1" \
  --tenant "api1 tenant" --tenant-slug "$TENANT" --json \
  > "$RUN_DIR/auth-signup.log" 2>&1 || {
  echo "[api-1] signup failed (see auth-signup.log)" >&2
  tail "$RUN_DIR/auth-signup.log" >&2
  exit 1
}
echo "[api-1] signup ok in $(($(date +%s%3N)-START)) ms"

# Cold sync — main workload to profile on server side.
# Cap to SYNC_TIMEOUT_S to keep run time bounded (912k objects = hours).
SYNC_TIMEOUT_S="${SYNC_TIMEOUT_S:-120}"
echo "[api-1] cold sync (timeout ${SYNC_TIMEOUT_S}s) ..."
START=$(date +%s%3N)
timeout "$SYNC_TIMEOUT_S" node --enable-source-maps "$CLI" sync \
  --server "$SERVER_URL" --store "$SMOKE_BUNDLE" \
  --keep-local --object-concurrency 16 --batch-concurrency 4 \
  --json \
  1> "$RUN_DIR/sync.json" 2> "$RUN_DIR/sync.stderr.log" || {
    echo "[api-1] sync interrupted or failed (likely timeout reached); kept partial data" >&2
  }
SYNC_WALL=$(($(date +%s%3N)-START))
echo "[api-1] sync wall=${SYNC_WALL} ms"

# pg_stat_statements dump.
PGPASSWORD=prosa psql -h 127.0.0.1 -p 55432 -U prosa -d prosa --csv -c "
  SELECT calls, total_exec_time::int AS total_ms, mean_exec_time::numeric(10,2) AS mean_ms,
         (total_exec_time/NULLIF((SELECT SUM(total_exec_time) FROM pg_stat_statements),0)*100)::numeric(5,2) AS pct,
         rows,
         shared_blks_hit, shared_blks_read,
         left(query, 240) AS query_head
  FROM pg_stat_statements
  WHERE query NOT LIKE '%pg_stat_statements%'
  ORDER BY total_exec_time DESC
  LIMIT 30;
" > "$RUN_DIR/pg_stat_statements_top30.csv" 2>/dev/null || true

PGPASSWORD=prosa psql -h 127.0.0.1 -p 55432 -U prosa -d prosa --csv -c "
  SELECT
    (SELECT COUNT(*) FROM pg_stat_statements) AS distinct_queries,
    (SELECT SUM(calls) FROM pg_stat_statements) AS total_calls,
    (SELECT SUM(total_exec_time)::int FROM pg_stat_statements) AS total_exec_ms;
" > "$RUN_DIR/pg_stat_statements_overview.csv" 2>/dev/null || true

# Trigger profile flush.
echo "[api-1] SIGTERM API to flush profiles ..."
kill -TERM $API_PID 2>/dev/null || true
wait $API_PID 2>/dev/null || true

echo "[api-1] done; artifacts in $RUN_DIR"
echo "sync_wall_ms=$SYNC_WALL" > "$RUN_DIR/notes.md"
