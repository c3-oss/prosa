# Docker

prosa ships a multi-arch Docker image to GitHub Container Registry on every
release:

- `ghcr.io/c3-oss/prosa:<tag>` (e.g. `ghcr.io/c3-oss/prosa:v3.0.0`)
- `ghcr.io/c3-oss/prosa:latest`

Both tags exist for `linux/amd64` and `linux/arm64`.

## What's in the image

All three binaries, in `/usr/local/bin/`:

```
/usr/local/bin/prosa
/usr/local/bin/prosa-server
/usr/local/bin/prosa-panel
```

Base: `gcr.io/distroless/static-debian12`. No shell, no package manager,
no glibc — just the binaries and a minimal runtime. Image size on each arch
sits around 30 MB.

`ENTRYPOINT` is `prosa-server` (the most common reason to use the image).
Override `--entrypoint` to run the CLI or the panel.

## How it's built

`Dockerfile` at the repo root, multi-stage:

```dockerfile
ARG GO_VERSION=1.26.2

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -ldflags="-s -w" -o /out/ ./cmd/...

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/prosa        /usr/local/bin/prosa
COPY --from=build /out/prosa-server /usr/local/bin/prosa-server
COPY --from=build /out/prosa-panel  /usr/local/bin/prosa-panel
ENTRYPOINT ["/usr/local/bin/prosa-server"]
```

Notes:

- `CGO_ENABLED=0` keeps the build static — distroless has no glibc.
- `-s -w` strips debug symbols.
- `--platform=$BUILDPLATFORM` lets Buildx cross-compile from one builder.
- `TARGETOS`/`TARGETARCH` come from `docker buildx build --platform`.

## How it's pushed

`.github/workflows/release.yml`, after GoReleaser finishes:

```yaml
- uses: docker/setup-qemu-action@v3
- uses: docker/setup-buildx-action@v3
- uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}

- id: meta
  uses: docker/metadata-action@v5
  with:
    images: ghcr.io/${{ github.repository }}
    tags: |
      type=ref,event=tag
      type=raw,value=latest

- uses: docker/build-push-action@v5
  with:
    context: .
    platforms: linux/amd64,linux/arm64
    push: true
    tags: ${{ steps.meta.outputs.tags }}
    labels: ${{ steps.meta.outputs.labels }}
```

The `metadata-action` produces tags like `ghcr.io/c3-oss/prosa:v3.0.0`
and `ghcr.io/c3-oss/prosa:latest` — both pushed on the same run.

## Running

### As a server

```sh
docker run --rm \
  -e PROSA_DB_URL=postgres://prosa:prosa@db:5432/prosa?sslmode=disable \
  -e PROSA_S3_ENDPOINT=http://minio:9000 \
  -e PROSA_S3_BUCKET=prosa-raw \
  -e PROSA_S3_ACCESS_KEY=prosa \
  -e PROSA_S3_SECRET_KEY=prosaprosa \
  -e PROSA_ADMIN_TOKEN=changeme \
  -e PROSA_VERIFICATION_URI=https://panel.example.com/devices/approve \
  -p 7070:7070 \
  ghcr.io/c3-oss/prosa:latest
```

### As the panel

```sh
docker run --rm \
  --entrypoint prosa-panel \
  -e PROSA_PANEL_SERVER_URL=http://server:7070 \
  -e PROSA_ADMIN_TOKEN=changeme \
  -e PROSA_PANEL_OAUTH_GH_CLIENT_ID=... \
  -e PROSA_PANEL_OAUTH_GH_SECRET=... \
  -e PROSA_PANEL_COOKIE_KEY=$(openssl rand -hex 32) \
  -e PROSA_PANEL_COOKIE_SECURE=true \
  -e PROSA_OWNER_EMAILS=you@example.com \
  -e PROSA_PANEL_PUBLIC_URL=https://panel.example.com \
  -p 8080:8080 \
  ghcr.io/c3-oss/prosa:latest
```

### As the CLI

```sh
docker run --rm \
  --entrypoint prosa \
  ghcr.io/c3-oss/prosa:latest --help
```

Not the usual install path — for ad-hoc use only. There's no persistent
data dir mounted in this snippet; add `-v` if you want one.

## docker-compose for dev

The repo's `docker-compose.yml` provides a Postgres + MinIO dev stack.
Useful for self-hosting tests:

```sh
docker compose up -d                                  # Postgres + MinIO
docker run --rm --network host \
  -e PROSA_DB_URL=postgres://prosa:prosa@localhost:5432/prosa?sslmode=disable \
  -e PROSA_S3_ENDPOINT=http://localhost:9000 \
  -e PROSA_S3_BUCKET=prosa-raw \
  -e PROSA_S3_ACCESS_KEY=prosa \
  -e PROSA_S3_SECRET_KEY=prosaprosa \
  -e PROSA_ADMIN_TOKEN=devadmin \
  -e PROSA_VERIFICATION_URI=http://localhost:8080/devices/approve \
  ghcr.io/c3-oss/prosa:latest
```

## Local builds

```sh
just docker-build           # builds prosa:local for your host arch
docker run --rm prosa:local --help
```

For multi-arch builds locally (slower; uses QEMU):

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t prosa:local \
  --load \
  .
```

## When changing the Dockerfile

- Keep the runtime as distroless. Don't fall back to Debian or Alpine
  without a hard reason — distroless gives us the smallest possible
  attack surface.
- Keep `CGO_ENABLED=0`. The store uses `modernc.org/sqlite` (pure-Go)
  precisely to allow this. Switching to `mattn/go-sqlite3` would force
  CGO and a non-distroless runtime.
- Multi-arch matters: the matrix is `linux/{amd64,arm64}`. If you add
  a stage that doesn't honor `TARGETARCH`, multi-arch breaks.
- The image entrypoint is part of the public contract. If you change it,
  document the change in this file and in
  [`../self-hosting.md`](../self-hosting.md), and announce in the release
  notes.

Default validation lane for image changes:

```sh
just docker-build
docker run --rm prosa:local --version
```

For full multi-arch validation, the release runbook covers it; locally,
`docker buildx build --platform linux/amd64,linux/arm64 -t prosa:multi .`
is enough.

## Pulling a previous version

```sh
docker pull ghcr.io/c3-oss/prosa:v3.0.0
```

GHCR keeps all tagged versions; there is no garbage collection job today.

## Verifying

```sh
docker pull ghcr.io/c3-oss/prosa:latest
docker run --rm --entrypoint prosa ghcr.io/c3-oss/prosa:latest --version
```

Prints version, commit, and build date matching the GitHub Release.
