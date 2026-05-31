# Release runbook

The end-to-end playbook for cutting a release of prosa. If you are not the
maintainer cutting this release, you don't need this file.

## TL;DR

```sh
just ci                              # all lights green locally
just snapshot                        # dry-run goreleaser into dist/
just docker-build                    # check the three images build for your host arch
./bin/prosa --version                # sanity check
git tag v0.11.0
git push --tags
```

The `v*` tag triggers `.github/workflows/release.yml`, which orchestrates
GoReleaser, the npm publish script, and the Docker push.

## Pre-tag checklist

Run from a clean checkout of `master`:

1. **`just ci`** — the full local pipeline. Must be green. This covers:
   - `just tidy-check` — `go.mod`/`go.sum` already tidy.
   - `just gen-check` — no diff after `buf generate`.
   - `just vet` — `go vet` clean.
   - `just lint` — `golangci-lint` clean.
   - `just test-race` — full race-detector test suite.
   - `just build` — all three binaries build.
   - `git diff --exit-code` — no uncommitted regen.

2. **`just snapshot`** — local GoReleaser dry-run.
   - Builds the full matrix into `dist/`.
   - Renders archives + checksums.
   - Does **not** push to the Homebrew tap or GitHub.
   - Use to confirm there are no GoReleaser config errors before the real
     tag.

3. **`just docker-build`** — Dockerfile builds for the host arch,
   producing `prosa:local`, `prosa-server:local`, and `prosa-panel:local`.
   - `docker run --rm prosa:local --version` should print the same
     version/commit metadata as `./bin/prosa --version`. The other two
     images carry their named binaries.

4. **`./bin/prosa --version`** — confirms the buildinfo ldflags injected
   `Version`, `Commit`, `BuildDate`.

5. **Cross-check `ROADMAP.md`** — is this the release described under
   *Next*? Either way, ROADMAP gets updated as a follow-up PR after the
   release.

6. **Look at the changelog GoReleaser will publish**:

   ```sh
   git log $(git describe --tags --abbrev=0)..HEAD --oneline
   ```

   GoReleaser groups by `feat:` / `fix:` and excludes `docs:` / `test:` /
   `chore:` / `ci:` and merge commits — be sure the user-facing changes
   are conventional-commit-shaped.

## Tagging

prosa follows semver. Pre-releases use `-rc`, `-beta`, etc.; GoReleaser is
configured with `prerelease: auto`.

```sh
git tag v0.11.0                      # or v0.11.0-rc1, v0.11.0-beta1, etc.
git push --tags
```

That's the only manual step.

## What happens after the push

GitHub Actions runs `.github/workflows/release.yml`. One job, multi-step:

### Step 1 — GoReleaser

`goreleaser release --clean` runs in the Actions runner.

- Builds the 12 binaries (3 binaries × 2 OS × 2 arch).
- Publishes each binary as a raw release asset
  (`prosa_<v>_<os>_<arch>`, `prosa-server_<v>_<os>_<arch>`,
  `prosa-panel_<v>_<os>_<arch>` — 12 total).
- Also publishes a three-binary bundle tar.gz per OS/arch
  (`prosa_<v>_<os>_<arch>.tar.gz` — 4 total) that the Homebrew Cask
  installs and `install.sh` falls back to when raw assets are missing.
- Computes `checksums.txt` covering every asset.
- Renders the GitHub Release (title = `prosa v0.11.0`, body = grouped
  changelog).
- Pushes `Casks/prosa.rb` to `c3-oss/homebrew-prosa` using
  `HOMEBREW_TAP_TOKEN`. The Cask is pinned to the tar.gz bundle via
  `homebrew_casks[0].ids: [default]` so `brew install c3-oss/prosa/prosa`
  keeps installing all three binaries in one step.

Secrets used: `GITHUB_TOKEN` (auto), `HOMEBREW_TAP_TOKEN` (manual,
6-month rotation).

### Step 2 — npm publish

`scripts/publish-npm.sh` runs after GoReleaser.

- Reads `GITHUB_REF_NAME` (e.g. `v0.11.0`), strips `v` → `0.11.0`.
- Stamps `0.11.0` into all five `npm/*/package.json` files (and into
  the metapackage's `optionalDependencies`).
- Copies binaries from `dist/prosa_<os>_<arch>/prosa` into
  `npm/prosa-<platform>/bin/prosa`.
- Verifies all five versions match (aborts otherwise).
- Publishes the four sub-packages first, then `@c3-oss/prosa`.

Secret used: `NPM_TOKEN` (granular, `@c3-oss` org publish scope).

### Step 3 — Docker push

QEMU + Buildx multi-arch build and push. Three images, one per binary,
share the QEMU/Buildx setup and GHCR login. Each image is published with
the release tag and `latest`, for `linux/amd64` and `linux/arm64`:

- `ghcr.io/c3-oss/prosa` (CLI)
- `ghcr.io/c3-oss/prosa-server`
- `ghcr.io/c3-oss/prosa-panel`

The Dockerfile is multi-target (one named final stage per binary). The
shared `build` stage is cached by Buildx so all three targets reuse the
same compiled binaries.

Secret used: `GITHUB_TOKEN` (auto).

## Verifying the release

A few minutes after the workflow goes green:

```sh
# Homebrew (installs all three binaries from the tar.gz bundle)
brew update && brew install c3-oss/prosa/prosa
prosa --version

# install.sh — interactive prompt picks CLI / all / server / panel
PROSA_VERSION=v0.11.0 \
  curl -fsSL https://raw.githubusercontent.com/c3-oss/prosa/master/install.sh | sh
~/.local/bin/prosa --version

# Direct raw binary — one-liner for users who want just one component
curl -fsSL -o ~/.local/bin/prosa-server \
  https://github.com/c3-oss/prosa/releases/download/v0.11.0/prosa-server_0.11.0_darwin_arm64
chmod +x ~/.local/bin/prosa-server

# npm
npm install -g @c3-oss/prosa@0.11.0
prosa --version

# Docker — three images, one per binary
docker pull ghcr.io/c3-oss/prosa:v0.11.0
docker pull ghcr.io/c3-oss/prosa-server:v0.11.0
docker pull ghcr.io/c3-oss/prosa-panel:v0.11.0
docker run --rm ghcr.io/c3-oss/prosa:v0.11.0 --version
docker run --rm ghcr.io/c3-oss/prosa-server:v0.11.0 --version
docker run --rm ghcr.io/c3-oss/prosa-panel:v0.11.0 --version
```

Each should print the same version, commit, and build date as the
GitHub Release.

## When something fails

### GoReleaser step fails

The most common cause is an expired `HOMEBREW_TAP_TOKEN`. Symptom: the
GitHub Release succeeds, but the brew step errors with a 401. Fix:
rotate the token (see [homebrew.md](homebrew.md#homebrew_tap_token)),
re-run the workflow job.

Other GoReleaser failures usually surface in the action logs as YAML
schema errors. Reproduce with `just snapshot` locally; iterate.

### npm publish fails

Possible causes:

- **Version drift between sub-packages**: `publish-npm.sh` aborts before
  any publish. Fix the script or the artifacts and re-run the job.
- **`NPM_TOKEN` expired or wrong scope**: rotate, update the secret,
  re-run.
- **One sub-package failed mid-loop**: the script exits non-zero; later
  sub-packages and the metapackage don't publish. Re-run the job — `npm
  publish` rejects re-publishing the same version, but the script can
  detect already-published versions and skip them (or you can run the
  remaining `npm publish` commands manually from a checkout).

After fixing, re-run the workflow on the existing tag. GoReleaser is
configured to be idempotent within reason (the GitHub Release isn't
re-created if one exists for the tag).

### Docker push fails

Usually transient (GHCR rate limit, QEMU emulation flake). Re-run the
job.

## Hotfix path

For a fix you want to ship immediately:

1. Make the change on `master` (or branch + PR + merge).
2. Tag `vX.Y.Z+1` (semver patch).
3. Push tags.

There is no separate release branch in this MVP. Every release tag points
to a commit on `master`.

## Post-release

After all four channels confirm the new version is live:

- Update [`../../ROADMAP.md`](../../ROADMAP.md) — move what was under
  *Next* into the relevant section, queue the next thing.
- Close the GitHub milestone (if you use them).
- Drink coffee.

## Pre-release rotation reminders

- `HOMEBREW_TAP_TOKEN` — rotate every 6 months. Mark it on your calendar
  the day you generate it.
- `NPM_TOKEN` — granular tokens can be set to expire; check the npm
  account periodically.
- `GITHUB_TOKEN` — auto-rotated by Actions; no manual step.
- `PROSA_ADMIN_TOKEN`, `PROSA_PANEL_COOKIE_KEY` — these aren't release
  secrets; they live on your prod environment. Rotate on a schedule
  appropriate for your deployment.
