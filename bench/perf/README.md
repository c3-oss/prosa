# Performance profiling harness

> Local-only profiling rig. Não comita resultados pesados (`.cpuprofile`, `.heapprofile`, SVG, HTML). Vide `.gitignore`.

## Como reproduzir

### 1. Setup do ambiente

```bash
# Subir Postgres + MinIO em portas dedicadas (fora dos defaults).
PROSA_COMPOSE_POSTGRES_PORT=55432 \
PROSA_COMPOSE_MINIO_PORT=19000 \
PROSA_COMPOSE_MINIO_CONSOLE_PORT=19001 \
docker compose up -d postgres minio minio-create-bucket

# Cópia somente-uso do bundle real (regra: não tocar em ~/.prosa).
BUNDLE_DIR=/tmp/prosa-perf-bundle-$(date -u +%Y%m%dT%H%M%SZ)
/bin/cp -cR ~/.prosa "$BUNDLE_DIR"  # macOS APFS clonefile quando possível
echo "BUNDLE_DIR=$BUNDLE_DIR" > /tmp/prosa-perf-env

# Build com sourcemaps externos.
pnpm -F @c3-oss/prosa -F @c3-oss/prosa-api build
```

### 2. Rodar um cenário

```bash
source /tmp/prosa-perf-env
bash bench/perf/scenarios/cli-1-compile-all.sh
bash bench/perf/scenarios/cli-2-sync.sh
bash bench/perf/scenarios/api-1-commit-upload.sh
```

Cada script grava em `bench/perf/results/<UTC-timestamp>-<scenario>/`.

### 3. Visualizar profiles

```bash
# CPU profile no DevTools (Chrome) ou speedscope CLI:
npx --yes speedscope bench/perf/results/<dir>/*.cpuprofile

# GC log:
less bench/perf/results/<dir>/*.gc.log
```

## Notas

- Node 24.12.0 (devbox). Deep research mira Node 22; APIs `--cpu-prof`, `--heap-prof`, `perf_hooks` são compatíveis. Documentar versão exata em cada `notes.md`.
- Bench numérico **só** contra o bundle de produção (`dist/`), nunca `pnpm dev` (custo SWC infla 10–30%).
- Não rodar profilers em paralelo: competição por CPU/I-O invalida números.
- macOS = sem `perf`/`bpftrace`. Para hot paths que precisam de stackwalk em `.node`, usar Instruments Time Profiler (anotar como "validado apenas em Linux + proxy macOS").
