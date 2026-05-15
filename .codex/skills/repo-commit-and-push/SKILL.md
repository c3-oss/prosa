---
name: repo-commit-and-push
description: Use when committing or pushing changes in this repository. Create focused commits that match repo history, follow the Conventional Commits style enforced by commitlint, attach Changesets for user-facing changes, push only when requested, and always push tags whenever pushing.
---

# Repo Commit And Push

Apply this skill when a task in this repository includes committing changes or pushing to a
remote. The canonical commit hygiene rules also live in `AGENTS.md`; cross-reference it before
finalizing a commit message style.

## Policy

- Never collapse unrelated work into one commit.
- Every commit represents one complete, coherent delivery slice.
- Group files into a commit only when they share one purpose and can be described by one subject
  and one body.
- Before writing a commit message, inspect repo-local guidance (`AGENTS.md`, `commitlint.config.cjs`)
  and recent git history to confirm style and the active scope vocabulary.
- Split commits by coherent responsibility:
  - source changes per package (`core`, `api`, `cli`, `mcp`, `tui`, `sync`, `auth`)
  - tests and fixtures
  - documentation or skill instructions
  - editor or repository configuration
- If a task produces multiple coherent change sets, commit them separately in a logical order.
- Push only when the user explicitly asks for it.
- Whenever you push a branch or commit, also push tags to the same remote in the same work unit.
- Do not edit or commit generated output under `dist/`, `coverage/`, `.turbo/`, `node_modules/`,
  or `.devbox/`.

## Commit Format

- Follow Conventional Commits: `<type>(<scope>): <imperative summary>`.
- Allowed scopes come from `commitlint.config.cjs`:
  `cli`, `mcp`, `core`, `importers`, `services`, `tui`, `docs`, `test`, `deps`, `release`, `infra`,
  `api`, `sync`, `auth`.
- Use imperative mood and keep the subject concise (≤ 72 chars). Body lines stay ≤ 100 chars.
- Include a short explanatory body when the change is not self-evident.

Preferred template:

```text
<type>(<scope>): <imperative summary>

<One short paragraph explaining the change set and its purpose.>
```

## Changesets

- User-facing changes need a Changeset entry. Run `pnpm changeset`, pick the affected workspace
  packages (for example `@c3-oss/prosa`, `@c3-oss/prosa-core`, `@c3-oss/prosa-api`,
  `@c3-oss/prosa-db`, `@c3-oss/prosa-storage`, `@c3-oss/prosa-sync`) and the correct semver bump.
- The generated `.changeset/<slug>.md` ships in the same PR as the code change.
- Pure refactors, internal tests, or docs that do not affect consumers can use
  `pnpm changeset --empty` or be skipped per `AGENTS.md` guidance.
- `pnpm version-packages` consumes pending Changesets, bumps versions, and writes CHANGELOGs;
  `pnpm release` runs the build and publishes. Do not run these unless explicitly asked.

## Workflow

1. Review `git status` and identify distinct delivery slices.
2. Inspect `AGENTS.md`, `commitlint.config.cjs`, and recent git history to confirm the expected
   commit style and scope vocabulary.
3. If the style or split is still ambiguous, ask the user before committing.
4. Unstage any mixed work if needed, then regroup by context.
5. Stage only one coherent group at a time (prefer explicit paths over `git add -A`).
6. Before committing, check that every staged file belongs to the same purpose.
7. Commit with a subject and, when useful, an explanatory body for that one slice.
8. Add a Changeset when the slice affects consumers.
9. Repeat for remaining groups in a logical order.
10. If the user asked for a push, push the branch or commit to the configured remote.
11. Immediately after every push, push tags to the same remote.

For pushes, use the remote and branch implied by the current checkout unless the user requested a
specific target:

```sh
git push <remote> <branch>
git push <remote> --tags
```

## Guardrails

- Do not rewrite or squash existing commits unless explicitly asked.
- Do not make a "commit everything" commit just to clean the worktree.
- If one staged set cannot be explained as one complete change, split it again.
- If the worktree contains unrelated user changes, avoid staging them.
- Never bypass hooks (`--no-verify`, `--no-gpg-sign`) unless the user explicitly requests it.
