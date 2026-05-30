# Homebrew

prosa publishes a Homebrew cask to the external tap repo
[`c3-oss/homebrew-prosa`](https://github.com/c3-oss/homebrew-prosa). The
install command is:

```sh
brew install c3-oss/prosa/prosa
```

`c3-oss/prosa` is the shorthand Brew expands to `github.com/c3-oss/homebrew-prosa`.

## What gets installed

The cask installs all three binaries: `prosa`, `prosa-server`,
`prosa-panel`. They land under the Homebrew prefix (`/opt/homebrew/bin/` on
Apple Silicon, `/usr/local/bin/` on Intel).

The cask carries a small set of caveats printed after install:

```
To finish setup, run:

  prosa setup

That walks through device auth, installs the LaunchAgent
that keeps history in sync, and imports the first batch of
AI-agent sessions.
```

## How publishing happens

GoReleaser writes the cask file on every `v*` release. Configured in
`.goreleaser.yaml`:

```yaml
homebrew_casks:
  - name: prosa
    repository:
      owner: c3-oss
      name: homebrew-prosa
      token: '{{ .Env.HOMEBREW_TAP_TOKEN }}'
    commit_author:
      name: c3-oss-bot
      email: bot@c3.do
    binary: prosa
    extra_install: |
      bin.install "prosa-server"
      bin.install "prosa-panel"
    caveats: |
      ...
```

There is no manual `brew bump-cask-pr`. The release workflow's GoReleaser
step:

1. Builds the four archives (`{darwin,linux} × {amd64,arm64}`).
2. Computes sha256 for each.
3. Renders the cask Ruby file with the URLs and shas.
4. Clones `c3-oss/homebrew-prosa` using `HOMEBREW_TAP_TOKEN`.
5. Commits the new `Casks/prosa.rb` as `c3-oss-bot <bot@c3.do>`.
6. Pushes to `master`.

Brew users picking it up next time they run `brew update` will see the new
version.

## The tap repo

`c3-oss/homebrew-prosa` is intentionally bare. It has:

- A README pointing back at this repo.
- `Casks/prosa.rb` (auto-generated, do not hand-edit).

No CI runs there. No issues are filed there (they go to this repo).

If the cask ever needs to be hand-edited (rollback, force re-publish):

```sh
git clone https://github.com/c3-oss/homebrew-prosa
cd homebrew-prosa
# edit Casks/prosa.rb
git commit -am "manual fix: ..."
git push
```

Don't do this casually — the next GoReleaser run will overwrite it.

## HOMEBREW_TAP_TOKEN

This is a **classic PAT** (Personal Access Token) with `repo` scope on the
tap repository. Notes:

- Classic PAT, not fine-grained. Fine-grained PATs don't support all the
  git operations GoReleaser needs.
- Scope: `repo` (which transitively includes `repo:status`,
  `repo_deployment`, `public_repo`, `repo:invite`, `security_events`).
- Expiration: **6 months**. Mark it on the calendar when you generate it.
- Stored as a GitHub Actions secret on this repo (the `prosa` source repo),
  not on the tap.
- Rotation:
  1. Generate a new PAT.
  2. Update the secret `HOMEBREW_TAP_TOKEN` on this repo.
  3. Revoke the old PAT.
  4. Update the calendar.

If the token expires before rotation, the GoReleaser step in the release
workflow fails. The fix is to rotate and re-run the release job (the
GitHub Release and other channels are not affected because GoReleaser
treats the brew step as the last action of its run; see the action logs).

## First-time setup of the tap

Before the very first release ever, the tap must exist:

```sh
gh repo create c3-oss/homebrew-prosa --public \
  --description "Homebrew tap for prosa"
git clone https://github.com/c3-oss/homebrew-prosa
cd homebrew-prosa
mkdir Casks
git commit -m "init" --allow-empty
git push -u origin master
```

After that, GoReleaser will populate `Casks/prosa.rb` on every release.

## Verifying

```sh
brew tap c3-oss/prosa
brew search prosa            # finds c3-oss/prosa/prosa
brew install c3-oss/prosa/prosa
prosa --version              # confirms version, commit, build date
```

To uninstall:

```sh
brew uninstall prosa
brew untap c3-oss/prosa
```
