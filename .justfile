set shell := ["/bin/bash", "-c"]

BIN := "bin"
CLI := "bin/prosa"

# --------------------------------------------------------------------------------------------------

_help:
    @just --list

# --------------------------------------------------------------------------------------------------

# install protobuf generators into ./bin
tools:
    @mkdir -p {{ BIN }}
    GOBIN="$PWD/{{ BIN }}" go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.0
    GOBIN="$PWD/{{ BIN }}" go install connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.18.0

# regenerate protobuf Go code
gen: tools
    PATH="$PWD/{{ BIN }}:$PATH" buf lint
    PATH="$PWD/{{ BIN }}:$PATH" buf generate
    if command -v gofumpt >/dev/null 2>&1; then gofumpt -w gen/; fi

# build all prosa binaries into bin/
build:
    @mkdir -p {{ BIN }}
    go build -o {{ BIN }}/ ./cmd/...

# build then run bin/prosa with the given args
run *ARGS:
    @just build
    @{{ CLI }} {{ ARGS }}

# run go test ./...
test:
    go test ./...

# run the test suite with the race detector
test-race:
    go test -race -count=1 ./...

# coverage profile + per-function totals
cover:
    go test -coverprofile=coverage.out ./...
    go tool cover -func=coverage.out | tail -20

# go vet ./...
vet:
    go vet ./...

# golangci-lint
lint:
    golangci-lint run ./...

# go mod tidy
tidy:
    go mod tidy

# verify go.mod/go.sum are already tidy
tidy-check:
    go mod tidy
    git diff --exit-code -- go.mod go.sum

# verify generated code is already committed
gen-check: gen
    git diff --exit-code -- gen/

# local CI lane
ci: tidy-check gen-check vet lint test-race build
    git diff --exit-code

# goreleaser dry run for local release validation
snapshot:
    @command -v goreleaser >/dev/null 2>&1 || { echo "goreleaser is required for just snapshot"; exit 127; }
    goreleaser release --snapshot --clean

# build the local Docker image
docker-build:
    docker build -t prosa:local .

# remove build outputs
clean:
    rm -rf {{ BIN }} dist coverage.out coverage.txt coverage.html *.test
