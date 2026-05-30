.DEFAULT_GOAL := help

BIN := $(CURDIR)/bin
GOBIN := $(BIN)
export GOBIN
export PATH := $(BIN):$(PATH)

PROTOC_GEN_GO_VERSION         := v1.36.0
PROTOC_GEN_CONNECT_GO_VERSION := v1.18.0

GO_FILES := $(shell find . -type f -name '*.go' -not -path './gen/*' -not -path './vendor/*' -not -path './bin/*' 2>/dev/null)

.PHONY: help tidy tools gen lint test build ci clean

help:
	@echo "Targets:"
	@echo "  tidy    go mod tidy"
	@echo "  tools   install protoc-gen-go + protoc-gen-connect-go into ./bin"
	@echo "  gen     buf generate (regenerates ./gen)"
	@echo "  lint    golangci-lint run ./..."
	@echo "  test    go test -race -count=1 ./..."
	@echo "  build   go build ./cmd/... into ./bin"
	@echo "  ci      tidy + tools + gen + lint + test + build + git diff --exit-code"
	@echo "  clean   remove ./bin and test artifacts"

tidy:
	go mod tidy

tools: $(BIN)/protoc-gen-go $(BIN)/protoc-gen-connect-go

$(BIN)/protoc-gen-go:
	@mkdir -p $(BIN)
	go install google.golang.org/protobuf/cmd/protoc-gen-go@$(PROTOC_GEN_GO_VERSION)

$(BIN)/protoc-gen-connect-go:
	@mkdir -p $(BIN)
	go install connectrpc.com/connect/cmd/protoc-gen-connect-go@$(PROTOC_GEN_CONNECT_GO_VERSION)

gen: tools
	buf generate
	@if command -v gofumpt >/dev/null 2>&1; then gofumpt -w gen/ 2>/dev/null || true; fi

lint:
	golangci-lint run ./...

test:
	go test -race -count=1 ./...

build:
	@mkdir -p $(BIN)
	go build -o $(BIN)/ ./cmd/...

ci: tidy tools gen lint test build
	@git diff --exit-code || { echo ""; echo "ERROR: working tree dirty after pipeline (forgot to commit regenerated code or formatted files?)"; exit 1; }

clean:
	rm -rf $(BIN) coverage.txt coverage.html *.test *.out
