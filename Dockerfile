# syntax=docker/dockerfile:1
ARG GO_VERSION=1.26.2

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
# Build metadata mirroring the GoReleaser ldflags so image binaries
# report a real version instead of "dev (none, unknown)".
ARG VERSION=dev
ARG COMMIT=none
ARG BUILD_DATE=unknown
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN mkdir -p /out && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -ldflags="-s -w \
      -X github.com/c3-oss/prosa/internal/buildinfo.Version=${VERSION} \
      -X github.com/c3-oss/prosa/internal/buildinfo.Commit=${COMMIT} \
      -X github.com/c3-oss/prosa/internal/buildinfo.BuildDate=${BUILD_DATE}" \
    -o /out/ ./cmd/...

FROM gcr.io/distroless/static-debian12 AS prosa
COPY --from=build /out/prosa /usr/local/bin/prosa
ENTRYPOINT ["/usr/local/bin/prosa"]

FROM gcr.io/distroless/static-debian12 AS prosa-server
COPY --from=build /out/prosa-server /usr/local/bin/prosa-server
ENTRYPOINT ["/usr/local/bin/prosa-server"]

FROM gcr.io/distroless/static-debian12 AS prosa-panel
COPY --from=build /out/prosa-panel /usr/local/bin/prosa-panel
ENTRYPOINT ["/usr/local/bin/prosa-panel"]
