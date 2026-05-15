# <https://cheatography.com/linux-china/cheat-sheets/justfile/>
# <https://just.systems/man/en/chapter_1.html>


set shell := ["/bin/bash", "-c"]

set fallback

# --------------------------------------------------------------------------------------------------

default:
  @just _help

_help:
  @just --list

# --------------------------------------------------------------------------------------------------

# run a turbo command inside a package -- e.g. "just turbo build prosa-core"
[group('ALIASES')]
turbo cmd pkg-name *cmd-args:
  @pnpm turbo run {{ cmd }} {{ cmd-args }} --filter="@c3-oss/{{ pkg-name }}"

# run a turbo command on all packages
[group('ALIASES')]
turbo-all cmd:
  @pnpm turbo run {{ cmd }} --log-order=grouped

# install dependencies from pnpm-lock.yaml
[group('ALIASES')]
install:
  @pnpm install

# run commitizen, a CLI tool for generating conventional commits (interactive)
[group('ALIASES')]
commit:
  @pnpm cz

# run the prosa CLI through SWC -- e.g. "just dev sessions"
[group('ALIASES')]
dev *cmd-args:
  @pnpm --filter @c3-oss/prosa dev -- {{ cmd-args }}

# run the standard pre-release quality gate
[group('ALIASES')]
quality:
  @just typecheck
  @just test-all
  @just lint-all

# run TypeScript type checking without emitting files
[group('ALIASES')]
typecheck:
  @pnpm typecheck

# generate API documentation with TypeDoc
[group('ALIASES')]
docs:
  @pnpm run docs

# --------------------------------------------------------------------------------------------------

# build the package with the given name -- e.g. "just build prosa-core"
[group('BUILD')]
build pkg-name:
  @just turbo build {{ pkg-name }}

# build all packages
[group('BUILD')]
build-all:
  @just turbo-all build

# --------------------------------------------------------------------------------------------------

# remove all build artifacts, caches and turbo logs
[group('PROJECT MAINTENANCE')]
clean-all:
  @just turbo-all clean
  @rm -rf .turbo coverage docs/api

# --------------------------------------------------------------------------------------------------

# run the linter on the package with the given name -- e.g. "just lint prosa-core"
[group('CODE QUALITY')]
lint pkg-name:
  @just turbo lint {{ pkg-name }}

# run the linter on all packages
[group('CODE QUALITY')]
lint-all:
  @just turbo-all lint

# run the linter on all packages and fix all auto-fixable issues
[group('CODE QUALITY')]
lint-all-fix:
  @pnpm turbo lint:fix

# --------------------------------------------------------------------------------------------------

# run tests on the package with the given name -- e.g. "just test prosa-core"
[group('TESTS')]
test pkg-name:
  @just turbo test {{ pkg-name }}

# run tests on all packages
[group('TESTS')]
test-all:
  @just turbo-all test

# run tests on all packages and generate a coverage report
[group('TESTS')]
test-all-coverage:
  @just turbo-all test:coverage

# --------------------------------------------------------------------------------------------------

# create a package release plan (interactive)
[group('PACKAGE RELEASING')]
changeset:
  @pnpm changeset

# apply pending Changesets to package versions and changelog files
[group('PACKAGE RELEASING')]
version-packages:
  @pnpm version-packages

# create a package release plan (interactive)
[group('PACKAGE RELEASING')]
release-plan:
  @pnpm changeset

# apply the release plan created by "release-plan"
[group('PACKAGE RELEASING')]
release-apply:
  @pnpm version-packages

# publish all packages with new versions to the registry
[group('PACKAGE RELEASING')]
release-publish:
  @just build-all
  @pnpm changeset publish

# prepare to publish packages -- build, lint, test and apply remaining changesets
[group('PACKAGE RELEASING')]
release-prepare-publish:
  @just build-all
  @just lint-all
  @just test-all
  @just release-apply

# build and publish changed packages to the official npm registry
[group('PACKAGE RELEASING')]
release:
  @pnpm release
  @git push
  @git push --tags

# --------------------------------------------------------------------------------------------------

# enter prerelease mode
[group('PACKAGE PRE-RELEASING')]
prerelease-enter:
  @pnpm changeset pre enter next

# exit prerelease mode
[group('PACKAGE PRE-RELEASING')]
prerelease-exit:
  @pnpm changeset pre exit

# generate and publish a prerelease package
[group('PACKAGE PRE-RELEASING')]
prerelease-publish:
  @just prerelease-enter
  @just release-plan
  @just release-apply
  @just release-publish
  @just prerelease-exit
