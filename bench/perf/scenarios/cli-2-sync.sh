#!/usr/bin/env bash
# CLI-2 — prosa sync contra API local (sem profiler no servidor; profiler no cliente).
# A API local roda como subprocess para que possamos profilar o cliente.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source /tmp/prosa-perf-env

TS=$(date -u +%Y%m%dT%H%M%SZ)
RUN_DIR="bench/perf/results/${TS}-cli-2"
mkdir -p "$RUN_DIR/profiles"
bash bench/perf/tools/collect-env.sh "$RUN_DIR"

CLI="apps/cli/dist/bin/prosa.js"
API="apps/api/dist/bin/prosa-api.js"

# Server env (postgres + minio from docker stack on alt ports)
export PROSA_RUNTIME_MODE=production
export PROSA_API_HOST=127.0.0.1
export PROSA_API_PORT=30080
export PROSA_API_URL=http://127.0.0.1:30080
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

echo "[cli-2] starting API server (background) ..."
node --enable-source-maps "$API" > "$RUN_DIR/api.stdout.log" 2> "$RUN_DIR/api.stderr.log" &
API_PID=$!
trap "kill $API_PID 2>/dev/null || true" EXIT INT TERM

# Wait for /health
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:30080/health >/dev/null 2>&1; then
    echo "[cli-2] API healthy after ${i}s"
    break
  fi
  sleep 1
done

# CLI sync needs a server config & creds. We bootstrap with the auth CLI subcommand.
RUN_BUNDLE="${BUNDLE_DIR}-cli2-${TS}"
echo "[cli-2] cloning bundle to $RUN_BUNDLE ..."
/bin/cp -cR "$BUNDLE_DIR" "$RUN_BUNDLE"

CFG_DIR="$RUN_DIR/cli-config"
mkdir -p "$CFG_DIR"
export PROSA_CONFIG_PATH="$CFG_DIR/config.json"

EMAIL="bench-$(date +%s)@example.com"
PASSWORD="correct-horse-battery"
TENANT="bench-$(date +%s)"
SERVER_URL="http://127.0.0.1:30080"

echo "[cli-2] bootstrapping auth (signup + tenant) ..."
node --enable-source-maps "$CLI" auth signup \
  --server "$SERVER_URL" --email "$EMAIL" --password "$PASSWORD" --name "bench" \
  --tenant "bench tenant" --tenant-slug "$TENANT" --json \
  > "$RUN_DIR/auth-signup.log" 2>&1 || {
    echo "[cli-2] signup failed; see $RUN_DIR/auth-signup.log" >&2
    exit 1
  }

NODE_FLAGS=(
  --enable-source-maps
  --cpu-prof
  --cpu-prof-dir="$RUN_DIR/profiles"
  --cpu-prof-name="cli2-sync.cpuprofile"
  --cpu-prof-interval=500
  --heap-prof
  --heap-prof-dir="$RUN_DIR/profiles"
  --heap-prof-name="cli2-sync.heapprofile"
)

echo "[cli-2] profiled cold sync ..."
NODE_OPTIONS="--trace-gc" \
node "${NODE_FLAGS[@]}" "$CLI" sync \
  --server "$SERVER_URL" --tenant "$TENANT" --store "$RUN_BUNDLE" \
  --keep-local --object-concurrency 8 --batch-concurrency 4 \
  --json \
  1> "$RUN_DIR/sync-cold.stdout.json" 2> "$RUN_DIR/sync-cold.gc.log" || {
    echo "[cli-2] cold sync failed; tail of gc log:" >&2
    tail -50 "$RUN_DIR/sync-cold.gc.log" >&2
    exit 1
  }

echo "[cli-2] baseline hyperfine warm re-sync (3 runs) ..."
hyperfine --runs 3 --warmup 0 \
  --export-json "$RUN_DIR/hyperfine-warm.json" \
  --export-markdown "$RUN_DIR/hyperfine-warm.md" \
  "node --enable-source-maps '$CLI' sync --server '$SERVER_URL' --tenant '$TENANT' --store '$RUN_BUNDLE' --keep-local --json > /dev/null" \
  || true

rm -rf "$RUN_BUNDLE"
kill $API_PID 2>/dev/null || true
echo "[cli-2] done. artifacts in $RUN_DIR"
