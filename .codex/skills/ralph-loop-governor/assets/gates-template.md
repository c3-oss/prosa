# <Feature> Gates

## Required Commands

| Command | Required | Last Result | Notes |
| --- | --- | --- | --- |
| `pnpm i` | yes | not-run | |
| `pnpm build` | yes | not-run | |
| `just typecheck` | yes | not-run | |
| `just test-all` | yes | not-run | |
| `just lint-all` | yes | not-run | |
| `just e2e-up` | yes | not-run | |
| `just e2e` | yes | not-run | |
| `just e2e-cli` | yes | not-run | |
| `just e2e-down` | yes | not-run | |
| `pnpm audit --audit-level moderate` | yes | not-run | |
| `git diff --check` | yes | not-run | |

## Done Check

- [ ] Worktree state documented.
- [ ] All lanes have evidence.
- [ ] No open blocking corrections.
- [ ] Docker-backed E2E passed or blocker is documented.
- [ ] Audit output classified.
- [ ] Final Codex review completed.
