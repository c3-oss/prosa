---
name: repo-commit-and-push
description: Use when committing or pushing changes in this repository. Create focused commits that match repo history, push only when requested, and always push tags whenever pushing.
---

# Repo Commit And Push

Apply this skill when a task in this repository includes committing changes or pushing to a
remote.

## Policy

- Never collapse unrelated work into one commit.
- Every commit must represent one complete, coherent delivery slice.
- Group files into a commit only when they share one purpose and can be described by one subject
  and one body.
- Before writing a commit message, inspect repo-local guidance and recent git history to determine
  the expected commit style.
- If the expected commit style is ambiguous after checking guidance and history, ask the user
  before committing.
- Split commits by coherent responsibility:
  - source changes
  - tests and fixtures
  - documentation or skill instructions
  - editor or repository configuration
- If a task produces multiple coherent change sets, commit them separately in a logical order.
- Push only when the user explicitly asks for it.
- Whenever you push a branch or commit, also push tags to the same remote in the same work unit.
- Do not edit or commit generated output under `dist/`, `coverage/`, `node_modules/`, or
  `.devbox/`.

## Commit Format

- Follow the commit style used by this repository after verifying it from `AGENTS.md` and recent
  git history.
- Prefer the scoped Conventional Commit style commonly used here:
  `<type>(<scope>): <imperative summary>`.
- Use imperative mood and keep the subject concise.
- Include a short explanatory body when the change is not self-evident.

Preferred template:

```text
<type>(<scope>): <imperative summary>

<One short paragraph explaining the change set and its purpose.>
```

## Workflow

1. Review `git status` and identify distinct delivery slices.
2. Inspect repo-local guidance and recent git history to determine the expected commit style.
3. If the style is still ambiguous, ask the user before committing.
4. Unstage any mixed work if needed, then regroup by context.
5. Stage only one coherent group at a time.
6. Before committing, check that every staged file belongs to the same purpose.
7. Commit with a subject and, when useful, an explanatory body for that one slice.
8. Repeat for remaining groups in a logical order.
9. If the user asked for a push, push the branch or commit to the configured remote.
10. Immediately after every push, push tags to the same remote.

For pushes, use the remote and branch implied by the current checkout unless the user requested a
specific target. A typical sequence is:

```sh
git push <remote> <branch>
git push <remote> --tags
```

## Guardrails

- Do not rewrite or squash existing commits unless explicitly asked.
- Do not make a "commit everything" commit just to clean the worktree.
- If one staged set cannot be explained as one complete change, split it again.
- If the worktree contains unrelated user changes, avoid staging them.
