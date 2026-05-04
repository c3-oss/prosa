set dotenv-load := false

default:
  just --list

install:
  pnpm install

build:
  pnpm build

test:
  pnpm test

lint:
  pnpm lint

typecheck:
  pnpm typecheck

clean:
  pnpm clean

quality:
  pnpm typecheck
  pnpm test
  pnpm lint

changeset:
  pnpm changeset

version-packages:
  pnpm version-packages

release:
  pnpm release
