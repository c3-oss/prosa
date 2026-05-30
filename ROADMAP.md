# Roadmap

The high-level direction lives in [`INTENT.md`](INTENT.md). This file is the
short-horizon list — what is actively being worked on or queued next.

prosa is still unstable; versions live in the `0.y.z` range. The next
release is `0.11.0`.

## Next: first real release (`v0.11.0`)

Bootstrap the external pieces and tag `v0.11.0`. Concretely:

- Create the public `c3-oss/homebrew-prosa` tap repo (empty).
- Generate `HOMEBREW_TAP_TOKEN` (classic PAT, `repo` scope on the tap) and
  `NPM_TOKEN` (granular, scoped to the `@c3-oss` org).
- Reserve the four platform package names on npm
  (`@c3-oss/prosa-{darwin,linux}-{arm64,amd64}`) with a dummy `0.11.0` publish.
- `git tag v0.11.0 && git push --tags` triggers the full pipeline
  (see [`docs/distribution/release.md`](docs/distribution/release.md)).

**Trade-off.** About thirty minutes of one-time manual setup before any
channel works. It is the real fire test for the distribution pipeline.

## After v0.11.0

Captured loosely so they don't get lost; not commitments. Each of these
becomes a real plan only when the central question demands it.

- Cursor and Gemini importers stabilize against representative captures.
- Panel: airy redesign per [`docs/panel/design-brief.md`](docs/panel/design-brief.md).
- Token / cost ingestion across importers (the data is in the raw; the
  canonical schema needs the slots).
- Optional MCP server (high-value, intentionally post-MVP per INTENT).
- Organizations / users (also intentionally post-MVP per INTENT — schema
  doesn't carry hooks yet).

When something here graduates to active work, it moves up under **Next** with
a concrete checklist.
