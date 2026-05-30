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
