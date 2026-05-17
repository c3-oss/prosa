#!/usr/bin/env bash
# CLI-1 — prosa compile-all em bundle real (cópia /tmp).
# Captura: wall-time (hyperfine), .cpuprofile, .heapprofile, gc.log
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

source /tmp/prosa-perf-env

TS=$(date -u +%Y%m%dT%H%M%SZ)
RUN_DIR="bench/perf/results/${TS}-cli-1"
mkdir -p "$RUN_DIR/profiles"
bash bench/perf/tools/collect-env.sh "$RUN_DIR"

# Use a fresh bundle clone per run so we always re-run the full compile pipeline.
RUN_BUNDLE="${BUNDLE_DIR}-cli1-${TS}"
echo "[cli-1] cloning bundle to $RUN_BUNDLE ..."
/bin/cp -cR "$BUNDLE_DIR" "$RUN_BUNDLE"
echo "[cli-1] bundle ready: $(du -sh "$RUN_BUNDLE" | awk '{print $1}')"

CLI="apps/cli/dist/bin/prosa.js"
NODE_FLAGS=(
  --enable-source-maps
  --cpu-prof
  --cpu-prof-dir="$RUN_DIR/profiles"
  --cpu-prof-name="cli1-compile-all.cpuprofile"
  --cpu-prof-interval=200   # 200 µs -> mais resolução em curtas (~1-2% extra)
  --heap-prof
  --heap-prof-dir="$RUN_DIR/profiles"
  --heap-prof-name="cli1-compile-all.heapprofile"
  --heap-prof-interval=131072  # 128 KiB
)

echo "[cli-1] profiled run ..."
NODE_OPTIONS="--trace-gc" \
  node "${NODE_FLAGS[@]}" "$CLI" compile-all --store "$RUN_BUNDLE" --json-logs \
    1> "$RUN_DIR/profiled.stdout.log" 2> "$RUN_DIR/profiled.gc.log" || {
      echo "[cli-1] profiled run failed; see $RUN_DIR/profiled.gc.log" >&2
      exit 1
    }

echo "[cli-1] baseline hyperfine (3 runs, fresh clone each) ..."
hyperfine \
  --runs 3 \
  --warmup 0 \
  --prepare "rm -rf '$RUN_BUNDLE' && /bin/cp -cR '$BUNDLE_DIR' '$RUN_BUNDLE'" \
  --export-json "$RUN_DIR/hyperfine.json" \
  --export-markdown "$RUN_DIR/hyperfine.md" \
  "node --enable-source-maps '$CLI' compile-all --store '$RUN_BUNDLE' --json-logs > '$RUN_DIR/run-\$HYPERFINE_RUN.stdout.log' 2>&1" \
  || true  # capture even on >15% variance; we'll re-run if needed

rm -rf "$RUN_BUNDLE"
echo "[cli-1] done. artifacts in $RUN_DIR"
