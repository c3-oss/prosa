# <Feature> Gates

## Base Commands

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `pnpm i` | yes | not-run | |
| `pnpm build` | yes | not-run | |
| `just typecheck` | yes | not-run | |
| `just test-all` | yes | not-run | |
| `just lint-all` | yes | not-run | |
| `pnpm audit --audit-level moderate` | yes | not-run | |
| `git diff --check` | yes | not-run | |

## Domain Commands

Populate from the matched domain skill. Example for server-sync:

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `just e2e-up` | yes | not-run | server-sync Docker harness |
| `just e2e` | yes | not-run | API + Postgres + object store |
| `just e2e-cli` | yes | not-run | CLI two-device flow |
| `just e2e-down` | yes | not-run | teardown |

## Done Check

- [ ] Worktree state documented.
- [ ] All lanes have evidence.
- [ ] No open blocking corrections.
- [ ] Domain gates passed or blockers are documented.
- [ ] Audit output classified.
- [ ] Final Codex review completed.
