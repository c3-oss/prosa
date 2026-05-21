#!/usr/bin/env bash
#
# apps/api/scripts/docker-smoke.sh
#
# Build the prosa-api Docker image, bring up the production compose
# stack (postgres + minio + api), and probe /health. Catches Dockerfile
# regressions like missing v2 packages that only surface at runtime
# when the API tries to import them.
#
# Usage: from repo root, `apps/api/scripts/docker-smoke.sh`.
# Optional env: PROSA_SMOKE_API_PORT (default 3015) — host port to
# expose api on. Postgres/MinIO use non-default ports to stay out of
# the way of any local stack.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

PROJECT_NAME="prosa-smoke-$$"
ENV_FILE="$(mktemp -t prosa-smoke-env.XXXXXX)"
OVERRIDE_FILE="$(mktemp -t prosa-smoke-override.XXXXXX.yml)"

cleanup() {
  local exit_code=$?
  echo "==> Cleaning up smoke stack (exit $exit_code)"
  docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" \
    -f docker-compose.yml -f "$OVERRIDE_FILE" down -v >/dev/null 2>&1 || true
  rm -f "$ENV_FILE" "$OVERRIDE_FILE"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# Generate the required production secrets and bind to non-default
# ports so the smoke doesn't collide with any local stack.
cat > "$ENV_FILE" <<EOF
PROSA_AUTH_SECRET=$(openssl rand -hex 32)
PROSA_CURSOR_HMAC_SECRET=$(openssl rand -hex 32)
PROSA_COMPOSE_API_PORT=${PROSA_SMOKE_API_PORT:-3015}
PROSA_COMPOSE_POSTGRES_PORT=54395
PROSA_COMPOSE_MINIO_PORT=9195
PROSA_COMPOSE_MINIO_CONSOLE_PORT=9196
EOF

# Production mode requires a KMS-backed receipt signer. Smoke runs in
# development so the in-process signer is enough to boot.
cat > "$OVERRIDE_FILE" <<'EOF'
services:
  api:
    environment:
      PROSA_RUNTIME_MODE: development
EOF

COMPOSE=(docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" \
  -f docker-compose.yml -f "$OVERRIDE_FILE")

echo "==> Building prosa-api image"
"${COMPOSE[@]}" build api

echo "==> Bringing up postgres + minio + bucket"
"${COMPOSE[@]}" up -d postgres minio minio-create-bucket

echo "==> Bringing up api"
"${COMPOSE[@]}" up -d api

API_PORT="${PROSA_SMOKE_API_PORT:-3015}"
HEALTH_URL="http://127.0.0.1:${API_PORT}/health"
echo "==> Probing ${HEALTH_URL} (90s budget)"
for i in $(seq 1 45); do
  if curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "==> /health reachable after ${i} attempt(s)"
    body="$(curl -s "${HEALTH_URL}")"
    echo "==> body: ${body}"
    case "${body}" in
      *'"ok":true'*) echo "==> smoke OK"; exit 0 ;;
      *) echo "==> /health returned unexpected body"; exit 1 ;;
    esac
  fi
  sleep 2
done

echo "==> /health never came up — dumping api logs"
"${COMPOSE[@]}" logs api | tail -120
exit 1
