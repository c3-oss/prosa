# Roadmap

The high-level direction lives in [`INTENT.md`](INTENT.md). This file is the
short-horizon list — what is actively being worked on or queued next.

prosa is still unstable; versions live in the `0.y.z` range. The current
release is `0.11.0`; the next patch will be cut as a follow-up.

## Next

Nothing actively queued. The "After v0.11.0" list below is the open
backlog — items move up here when they become real plans.

## After v0.11.0

Captured loosely so they don't get lost; not commitments. Each of these
becomes a real plan only when the central question demands it.

- Cursor and Gemini importers stabilize against representative captures.
- Token / cost ingestion across importers (the data is in the raw; the
  canonical schema needs the slots).
- Optional MCP server (high-value, intentionally post-MVP per INTENT).
- Organizations / users (also intentionally post-MVP per INTENT — schema
  doesn't carry hooks yet).

When something here graduates to active work, it moves up under **Next** with
a concrete checklist.
