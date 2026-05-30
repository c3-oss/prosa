# Prosa Release Check Prompt

Use this prompt before cutting a `v*` tag. The full runbook lives in
`docs/distribution/release.md`; this is the abbreviated checklist.

1. Run `just ci`. Must be green: tidy, gen-check, vet, lint, test-race,
   build, plus `git diff --exit-code`.
2. Run `just snapshot`. GoReleaser dry-run; verifies the full archive
   matrix (linux/darwin × amd64/arm64) without pushing.
3. Build the local image with `docker build -t prosa:local .`.
   `docker run --rm prosa:local --version` should print the same
   metadata as `./bin/prosa --version`.
4. Verify `./bin/prosa --version` prints the expected build metadata
   (Version, Commit, BuildDate). Dev metadata locally; tagged metadata
   on the release runner.
5. Confirm release targets remain macOS/Linux `amd64`/`arm64` unless
   `INTENT.md` changes (`.goreleaser.yaml` matrix).
6. Cross-check `ROADMAP.md` — is this the release described under
   *Next*?
7. Look at the changelog GoReleaser will publish:

   ```bash
   git log $(git describe --tags --abbrev=0)..HEAD --oneline
   ```

   User-facing changes should be conventional-commit-shaped
   (`feat:` / `fix:`) so they group correctly.

Report:

- any dirty generated files,
- release artifacts that do not include all three binaries,
- Docker entrypoint drift away from `prosa-server`,
- secrets close to expiry (`HOMEBREW_TAP_TOKEN` rotates every 6 months;
  see `docs/distribution/homebrew.md`).

After the tag is pushed, `.github/workflows/release.yml` handles
GoReleaser, npm publish, and the multi-arch Docker push. Verify the
release per `docs/distribution/release.md#verifying-the-release`.
