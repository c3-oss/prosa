#!/usr/bin/env bash
# Emit environment metadata for a profiling run.
# Usage: bash collect-env.sh > notes-env.json
set -euo pipefail
OUT_DIR="${1:-.}"
mkdir -p "$OUT_DIR"
COMMIT=$(git rev-parse HEAD)
DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
NODE_V=$(node --version)
OS=$(uname -a)
CPU_BRAND=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || cat /proc/cpuinfo | grep -m1 'model name' | sed 's/.*: //')
MEM_GB=$(echo "scale=1; $(sysctl -n hw.memsize 2>/dev/null || free -b | awk '/Mem/ {print $2}') / 1024 / 1024 / 1024" | bc)
cat <<JSON > "$OUT_DIR/env.json"
{
  "commit": "$COMMIT",
  "dirtyFiles": $DIRTY,
  "nodeVersion": "$NODE_V",
  "uname": "$OS",
  "cpu": "$CPU_BRAND",
  "memoryGB": $MEM_GB,
  "runStartUtc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "bundleDir": "${BUNDLE_DIR:-unset}",
  "postgresPort": "${PROSA_COMPOSE_POSTGRES_PORT:-55432}",
  "minioPort": "${PROSA_COMPOSE_MINIO_PORT:-19000}"
}
JSON
echo "env metadata -> $OUT_DIR/env.json"
