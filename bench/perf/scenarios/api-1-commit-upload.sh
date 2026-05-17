#!/usr/bin/env bash
# API-1 — Servidor Fastify/tRPC sob carga.
# Strategy: spawn API local com --cpu-prof, executar workload de sync.commit-upload via CLI.
#   (autocannon contra rotas tRPC requer payload binário; mais simples reaproveitar o
#    workload do CLI-2 e profilar o lado servidor desta vez.)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source /tmp/prosa-perf-env

TS=$(date -u +%Y%m%dT%H%M%SZ)
RUN_DIR="bench/perf/results/${TS}-api-1"
mkdir -p "$RUN_DIR/profiles"
bash bench/perf/tools/collect-env.sh "$RUN_DIR"

CLI="apps/cli/dist/bin/prosa.js"
API="apps/api/dist/bin/prosa-api.js"

export PROSA_RUNTIME_MODE=production
export PROSA_API_HOST=127.0.0.1
export PROSA_API_PORT=30081
export PROSA_API_URL=http://127.0.0.1:30081
export PROSA_WEB_ORIGIN=http://localhost:5173
export PROSA_LOG_LEVEL=info
export PROSA_DATABASE_URL=postgres://prosa:prosa@127.0.0.1:55432/prosa
export PROSA_AUTH_SECRET=perf-secret-only-for-bench
export PROSA_OBJECT_STORE_DRIVER=s3
export PROSA_OBJECT_STORE_BUCKET=prosa
export PROSA_OBJECT_STORE_PREFIX=prosa/
export PROSA_OBJECT_STORE_ENDPOINT=http://127.0.0.1:19000
export PROSA_OBJECT_STORE_REGION=us-east-1
export PROSA_OBJECT_STORE_ACCESS_KEY_ID=prosa
export PROSA_OBJECT_STORE_SECRET_ACCESS_KEY=prosa-minio

# Reset pg_stat_statements (requires extension installed).
PGPASSWORD=prosa psql -h 127.0.0.1 -p 55432 -U prosa -d prosa -c \
  "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;" 2>/dev/null || true
PGPASSWORD=prosa psql -h 127.0.0.1 -p 55432 -U prosa -d prosa -c \
  "SELECT pg_stat_statements_reset();" >/dev/null 2>&1 || true

NODE_FLAGS=(
  --enable-source-maps
  --cpu-prof
  --cpu-prof-dir="$RUN_DIR/profiles"
  --cpu-prof-name="api1-server.cpuprofile"
  --cpu-prof-interval=500
  --heap-prof
  --heap-prof-dir="$RUN_DIR/profiles"
  --heap-prof-name="api1-server.heapprofile"
)

echo "[api-1] starting profiled API server ..."
NODE_OPTIONS="--trace-gc" \
node "${NODE_FLAGS[@]}" "$API" > "$RUN_DIR/api.stdout.log" 2> "$RUN_DIR/api.gc.log" &
API_PID=$!
trap "kill $API_PID 2>/dev/null || true" EXIT INT TERM

# Wait health
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:30081/health >/dev/null 2>&1; then
    echo "[api-1] API healthy after ${i}s"
    break
  fi
  sleep 1
done

# Bootstrap signup + tenant
RUN_BUNDLE="${BUNDLE_DIR}-api1-${TS}"
echo "[api-1] cloning bundle to $RUN_BUNDLE ..."
/bin/cp -cR "$BUNDLE_DIR" "$RUN_BUNDLE"

CFG_DIR="$RUN_DIR/cli-config"
mkdir -p "$CFG_DIR"
export PROSA_CONFIG_PATH="$CFG_DIR/config.json"

EMAIL="bench-$(date +%s)@example.com"
PASSWORD="correct-horse-battery"
TENANT="bench-$(date +%s)"
SERVER_URL="http://127.0.0.1:30081"

node --enable-source-maps "$CLI" auth signup \
  --server "$SERVER_URL" --email "$EMAIL" --password "$PASSWORD" --name "bench" \
  --tenant "bench tenant" --tenant-slug "$TENANT" --json \
  > "$RUN_DIR/auth-signup.log" 2>&1 || {
    echo "[api-1] signup failed; see $RUN_DIR/auth-signup.log" >&2
    exit 1
  }

echo "[api-1] running sync workload (cold) ..."
node --enable-source-maps "$CLI" sync \
  --server "$SERVER_URL" --tenant "$TENANT" --store "$RUN_BUNDLE" \
  --keep-local \
  --object-concurrency 16 --batch-concurrency 8 \
  --json \
  1> "$RUN_DIR/sync.json" 2> "$RUN_DIR/sync.stderr.log" || {
    echo "[api-1] sync failed; tail of stderr:" >&2
    tail -50 "$RUN_DIR/sync.stderr.log" >&2
  }

# Dump pg_stat_statements
PGPASSWORD=prosa psql -h 127.0.0.1 -p 55432 -U prosa -d prosa --csv -c "
  SELECT calls, total_exec_time, mean_exec_time, rows,
         shared_blks_hit, shared_blks_read,
         left(query, 200) AS query_head
  FROM pg_stat_statements
  WHERE query NOT LIKE '%pg_stat_statements%'
  ORDER BY total_exec_time DESC
  LIMIT 30;
" > "$RUN_DIR/pg_stat_statements_top30.csv" 2>/dev/null || true

# pg_stat_activity snapshot
PGPASSWORD=prosa psql -h 127.0.0.1 -p 55432 -U prosa -d prosa --csv -c "
  SELECT application_name, state, COUNT(*) FROM pg_stat_activity GROUP BY 1,2;
" > "$RUN_DIR/pg_stat_activity_summary.csv" 2>/dev/null || true

# Shutdown — triggers cpu-prof/heap-prof flush.
echo "[api-1] sending SIGTERM to API to flush profiles ..."
kill -TERM $API_PID 2>/dev/null || true
wait $API_PID 2>/dev/null || true

rm -rf "$RUN_BUNDLE"
echo "[api-1] done. artifacts in $RUN_DIR"
