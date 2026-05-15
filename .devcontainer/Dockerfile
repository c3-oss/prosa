FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    postgresql-client \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
