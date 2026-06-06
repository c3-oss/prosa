# Distribution

How prosa ships. This directory documents the four channels prosa is
published through, plus the release runbook for maintainers.

For the **end-user** install experience see [`../install.md`](../install.md).
This tree is the back-of-house view: what the pipeline actually does, what
the config looks like, and where the secrets live.

## Channels at a glance

| Channel | Doc | Audience | Trigger |
| --- | --- | --- | --- |
| Homebrew | [homebrew.md](homebrew.md) | macOS users | GoReleaser on `v*` tag |
| Shell installer | [install-sh.md](install-sh.md) | Linux + macOS users | Built-in to the repo (`install.sh`) |
| npm | [npm.md](npm.md) | Any platform with Node ≥ 22 | `scripts/publish-npm.sh` on `v*` tag |
| Docker | [docker.md](docker.md) | Self-hosters | GitHub Actions on `v*` tag |

Every channel publishes the **same binary set** built by GoReleaser:
`prosa`, `prosa-server`, `prosa-panel`, for `linux × {amd64,arm64}` and
`darwin × {amd64,arm64}`.

## Release flow at a glance

```
git tag v0.11.0                               ┐
git push --tags                               │  human step
                                              ▼
.github/workflows/release.yml triggers        ┐
   ├─ goreleaser release --clean              │
   │    ├─ build 12 binaries (3 × 2 × 2)      │
   │    ├─ tar.gz archives                    │
   │    ├─ sha256 checksums.txt               │  one workflow run
   │    ├─ GitHub Release with notes          │
   │    └─ push Homebrew cask to              │
   │       c3-oss/homebrew-prosa              │
   │                                          │
   ├─ scripts/publish-npm.sh                  │
   │    ├─ stamp version into 5 package.json  │
   │    ├─ copy goreleaser bins into npm/     │
   │    ├─ publish 4 platform sub-packages    │
   │    └─ publish @c3-oss/prosa metapackage  │
   │                                          │
   └─ docker buildx — three images            │
        ├─ ghcr.io/c3-oss/prosa:<tag>, :latest│
        ├─ ghcr.io/c3-oss/prosa-server:…      │
        └─ ghcr.io/c3-oss/prosa-panel:…       ┘
```

Maintainer runbook: [release.md](release.md). The runbook covers the
pre-tag checks, the rotation schedule for `HOMEBREW_TAP_TOKEN`, and the
recovery steps when one of the publishers fails mid-run.

## Secrets

Required GitHub Actions repository secrets:

| Secret | Used by | Notes |
| --- | --- | --- |
| `HOMEBREW_TAP_TOKEN` | GoReleaser brew step | Classic PAT with `repo` scope on the external tap repo. Rotated ~every 6 months. |
| `NPM_TOKEN` | `scripts/publish-npm.sh` | Granular token, scoped to the `@c3-oss` org. Publish permission only. |
| `GITHUB_TOKEN` | GoReleaser + Docker push | Auto-provisioned by Actions; no rotation needed. |

`GITHUB_TOKEN` gets `packages: write` permission on the release workflow so
GHCR pushes succeed.

## Tooling pinning

The release uses the same `devbox.json` toolchain as CI. The release job
runs inside Actions with Go set up from `go.mod` and Node 24 set up via
`actions/setup-node`. GoReleaser itself is pinned via `~> 2` in the action
input.

## Channel diagram

What ends up where on a single `v*` push:

```
                       GoReleaser
                            │
                            ├─▶  GitHub Release          (tarballs + checksums.txt)
                            │
                            └─▶  c3-oss/homebrew-prosa   (Casks/prosa.rb,
                                Casks/prosa-server.rb, Casks/prosa-panel.rb)

                  scripts/publish-npm.sh
                            │
                            └─▶  npm registry
                                     ├─▶  @c3-oss/prosa
                                     ├─▶  @c3-oss/prosa-darwin-arm64
                                     ├─▶  @c3-oss/prosa-darwin-amd64
                                     ├─▶  @c3-oss/prosa-linux-amd64
                                     └─▶  @c3-oss/prosa-linux-arm64

                  Docker build + push (three images)
                            │
                            ├─▶  ghcr.io/c3-oss/prosa:<tag>, :latest
                            ├─▶  ghcr.io/c3-oss/prosa-server:<tag>, :latest
                            └─▶  ghcr.io/c3-oss/prosa-panel:<tag>, :latest
```

`install.sh` is not a "publish" step — it sits in the repo and pulls from
the GitHub Release. The only way it changes is by editing the script in a
PR. See [install-sh.md](install-sh.md) for the contract.
