# Docker

prosa ships **three** multi-arch Docker images to GitHub Container Registry
on every release. One image per binary, so the image name conveys what
runs:

| Image | Runs |
| --- | --- |
| `ghcr.io/c3-oss/prosa` | `prosa` (CLI) |
| `ghcr.io/c3-oss/prosa-server` | `prosa-server` |
| `ghcr.io/c3-oss/prosa-panel` | `prosa-panel` |

Each image is published with the release tag (e.g. `:v0.11.0`) and
`:latest`, for `linux/amd64` and `linux/arm64`.

## What's in each image

Exactly one binary at `/usr/local/bin/<binary>`, set as the image's
`ENTRYPOINT`. Base: `gcr.io/distroless/static-debian12`. No shell, no
package manager, no glibc — only the binary and a minimal runtime. Each
image sits around 30 MB per arch.

## How it's built

`Dockerfile` at the repo root, multi-target:

```dockerfile
# syntax=docker/dockerfile:1
ARG GO_VERSION=1.26.2

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN mkdir -p /out && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -ldflags='-s -w' -o /out/ ./cmd/...

FROM gcr.io/distroless/static-debian12 AS prosa
COPY --from=build /out/prosa /usr/local/bin/prosa
ENTRYPOINT ["/usr/local/bin/prosa"]

FROM gcr.io/distroless/static-debian12 AS prosa-server
COPY --from=build /out/prosa-server /usr/local/bin/prosa-server
ENTRYPOINT ["/usr/local/bin/prosa-server"]

FROM gcr.io/distroless/static-debian12 AS prosa-panel
COPY --from=build /out/prosa-panel /usr/local/bin/prosa-panel
ENTRYPOINT ["/usr/local/bin/prosa-panel"]
```

Notes:

- The `build` stage compiles all three binaries once. Each final stage
  copies only its binary. Buildx caches `build` across the three
  `--target` invocations.
- `CGO_ENABLED=0` keeps the binaries static — distroless has no glibc.
- `-s -w` strips debug symbols.
- `--platform=$BUILDPLATFORM` lets Buildx cross-compile from one
  builder; `TARGETOS`/`TARGETARCH` come from
  `docker buildx build --platform`.

## How it's pushed

`.github/workflows/release.yml`, after GoReleaser finishes. The job
sets up QEMU, Buildx, and the GHCR login once, then runs three
`metadata-action` + `build-push-action` pairs — one per target:

```yaml
- uses: docker/setup-qemu-action@v4
- uses: docker/setup-buildx-action@v4
- uses: docker/login-action@v4
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}

- id: meta-cli
  uses: docker/metadata-action@v6
  with:
    images: ghcr.io/${{ github.repository_owner }}/prosa
    tags: |
      type=ref,event=tag
      type=raw,value=latest

- uses: docker/build-push-action@v6
  with:
    context: .
    target: prosa
    platforms: linux/amd64,linux/arm64
    push: true
    tags: ${{ steps.meta-cli.outputs.tags }}
    labels: ${{ steps.meta-cli.outputs.labels }}

# … same pattern for prosa-server (meta-server) and prosa-panel
# (meta-panel), changing only `images:` and `target:`.
```

Each pair publishes two tags: the release tag (e.g.
`ghcr.io/c3-oss/prosa:v0.11.0`) and `latest`.

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
  -e PROSA_PANEL_BASE_URL=https://panel.example.com \
  -p 7070:7070 \
  ghcr.io/c3-oss/prosa-server:latest
```

### As the panel

```sh
docker run --rm \
  -e PROSA_PANEL_SERVER_URL=http://server:7070 \
  -e PROSA_ADMIN_TOKEN=changeme \
  -e PROSA_PANEL_OAUTH_GH_CLIENT_ID=... \
  -e PROSA_PANEL_OAUTH_GH_SECRET=... \
  -e PROSA_PANEL_COOKIE_KEY=$(openssl rand -hex 32) \
  -e PROSA_PANEL_COOKIE_SECURE=true \
  -e PROSA_OWNER_EMAILS=you@example.com \
  -e PROSA_PANEL_PUBLIC_URL=https://panel.example.com \
  -p 8080:8080 \
  ghcr.io/c3-oss/prosa-panel:latest
```

### As the CLI

```sh
docker run --rm ghcr.io/c3-oss/prosa:latest --help
```

Not the usual install path (brew / sh / npm are preferred for the CLI),
but useful for ad-hoc scripted contexts. No persistent data dir is
mounted in this snippet; add `-v` if you want one.

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
  -e PROSA_PANEL_BASE_URL=http://localhost:8080 \
  ghcr.io/c3-oss/prosa-server:latest
```

## Local builds

```sh
just docker-build                # builds all three local images
docker run --rm prosa:local --help
docker run --rm prosa-server:local --version
docker run --rm prosa-panel:local --version
```

The recipe runs three `docker build --target …` calls; buildx caches the
shared `build` stage so the second and third targets reuse the
already-compiled binaries.

For multi-arch builds locally (slower; uses QEMU):

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  --target prosa-server -t prosa-server:multi --load .
```

## When changing the Dockerfile

- Keep the runtime as distroless. Don't fall back to Debian or Alpine
  without a hard reason — distroless gives us the smallest possible
  attack surface.
- Keep `CGO_ENABLED=0`. The store uses `modernc.org/sqlite` (pure-Go)
  precisely to allow this. Switching to `mattn/go-sqlite3` would force
  CGO and a non-distroless runtime.
- Multi-arch matters: the matrix is `linux/{amd64,arm64}`. If you add a
  stage that doesn't honor `TARGETARCH`, multi-arch breaks.
- Each final stage must be named after the binary it carries
  (`prosa`, `prosa-server`, `prosa-panel`) — the `target:` in
  `release.yml` depends on it.
- Each image carries exactly one binary. Don't add the other binaries to
  any of the final stages.
- The set of published images is part of the public contract. If you add
  a new binary, you also add a new target stage and a new
  meta+build+push pair in `release.yml`, and document it here and in
  [`../self-hosting.md`](../self-hosting.md).

Default validation lane for image changes:

```sh
just docker-build
docker run --rm prosa:local --version
docker run --rm prosa-server:local --version
docker run --rm prosa-panel:local --version
```

For full multi-arch validation, the release runbook covers it; locally,
the `docker buildx build --platform linux/amd64,linux/arm64` invocation
above is enough.

## Pulling a previous version

```sh
docker pull ghcr.io/c3-oss/prosa:v0.11.0
docker pull ghcr.io/c3-oss/prosa-server:v0.11.0
docker pull ghcr.io/c3-oss/prosa-panel:v0.11.0
```

GHCR keeps all tagged versions; there is no garbage collection job
today.

## Verifying

```sh
docker pull ghcr.io/c3-oss/prosa:latest
docker pull ghcr.io/c3-oss/prosa-server:latest
docker pull ghcr.io/c3-oss/prosa-panel:latest

docker run --rm ghcr.io/c3-oss/prosa:latest --version
docker run --rm ghcr.io/c3-oss/prosa-server:latest --version
docker run --rm ghcr.io/c3-oss/prosa-panel:latest --version
```

Each prints version, commit, and build date matching the GitHub Release.
