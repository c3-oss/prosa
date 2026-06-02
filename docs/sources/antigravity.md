# Antigravity CLI source format

Antigravity CLI (`agy`) is Google's announced successor to the Gemini CLI.
Each conversation is stored as a standalone **SQLite database** under
`~/.gemini/antigravity-cli/conversations/`, with row blobs encoded as
**closed-source protobuf wire-format** for messages inherited from the
internal `gemini_coder` and `exa.cortex_pb` packages.

The legacy `gemini` importer at [`gemini.md`](gemini.md) still handles
Gemini CLI JSONL histories under `~/.gemini/tmp/` — the two coexist.

Imported by `internal/importers/antigravity/`.

## How we know the schema

Antigravity's CLI binary (`agy`) is a Google-internal Go build
(`go1.27 cl/906595525 +X:fieldtrack,boringcrypto,simd`). The on-disk
schema is **not** published, but every relevant proto message lives in
the binary as an embedded `FileDescriptorProto`, and `protoc-gen-go`'s
struct tags leak field numbers and names directly into the binary's
read-only string table. The companion **`google-antigravity/antigravity-sdk-python`**
package (Apache-2.0) ships the SDK-side `localharness.proto`, which
shares many messages.

Antigravity is a slightly rebranded fork of Codeium / Windsurf
"Cascade". The internal namespaces — `exa.cortex_pb`,
`exa.codeium_common_pb`, `exa.jetski_cortex_pb` — give the code its
provenance. "Jetski" is the internal codename for Antigravity itself,
and "Cascade" is the agent engine.

The importer decodes via `google.golang.org/protobuf/encoding/protowire`
using the recovered field map; every step degrades gracefully when a
field is missing.

## Layout

```text
~/.gemini/antigravity-cli/
  conversations/
    <conversation-uuid>.db          # one SQLite db per conversation
  brain/<conversation-uuid>/        # ignored (BrainEntry sidecars)
  cache/last_conversations.json     # ignored
  cache/projects.json               # ignored
  history.jsonl                     # ignored (prompt history sidecar)
  implicit/*.pb                     # ignored (ImplicitTrajectory)
  knowledge/                        # ignored (KnowledgeReference)
```

The `.db` filename UUID matches `trajectory_meta.cascade_id` inside the
database — both feed `session.Session.ID`.

## Identity

| Field | Source |
|---|---|
| Session ID | `trajectory_meta.cascade_id` (fallback: filename UUID) |
| Project path | first `file://…` string scanned out of `trajectory_metadata_blob.data` (`CortexTrajectoryMetadata`) |
| Project remote / marker | derived from project path via `internal/projectid.Apply` |
| Started / last activity | `CortexStepMetadata.created_at` (field 1) on the first / last step |
| First prompt | `gemini_coder.Step.user_input` (field 19 → sub-field 2) on the `step_type=USER_INPUT` row |
| Assistant text | `gemini_coder.Step.planner_response` (field 20 → sub-field 1) on every `step_type=PLANNER_RESPONSE` row |
| Model | `ExecutorMetadata.cascade_config` (field 10 → sub-field 1 → field 28) — full id, e.g. `gemini-3.5-flash-low` |
| Usage | `CortexStepMetadata.model_usage` (field 9 → `ModelUsageStats`) — see _Token usage_ below |

## Database schema

```sql
CREATE TABLE trajectory_meta (
  trajectory_id text, cascade_id text,
  trajectory_type integer, source integer,
  PRIMARY KEY (trajectory_id)
);
CREATE TABLE steps (
  idx integer, step_type integer NOT NULL DEFAULT 0,
  status integer NOT NULL DEFAULT 0,
  has_subtrajectory numeric NOT NULL DEFAULT false,
  metadata blob, error_details blob, permissions blob,
  task_details blob, render_info blob,
  step_payload blob, step_format integer NOT NULL DEFAULT 0,
  PRIMARY KEY (idx)
);
CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
CREATE TABLE executor_metadata (idx integer, data blob, PRIMARY KEY (idx));
CREATE TABLE parent_references (idx integer, data blob, PRIMARY KEY (idx));
CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id));
CREATE TABLE battle_mode_infos (idx integer, data blob, PRIMARY KEY (idx));
CREATE INDEX idx_steps_status ON steps(status);
CREATE INDEX idx_steps_step_type ON steps(step_type);
```

Each blob holds a serialized proto from `third_party/jetski/cortex_pb`:

| Column | Proto |
|---|---|
| `steps.metadata` | `exa.cortex_pb.CortexStepMetadata` (33 fields) |
| `steps.step_payload` | `gemini_coder.Step` (131 fields, giant oneof) |
| `gen_metadata.data` | `exa.cortex_pb.CortexStepGeneratorMetadata` |
| `executor_metadata.data` | `exa.cortex_pb.ExecutorMetadata` |
| `parent_references.data` | `exa.cortex_pb.CortexTrajectoryReference` |
| `trajectory_metadata_blob.data` | `exa.cortex_pb.CortexTrajectoryMetadata` |
| `battle_mode_infos.data` | `exa.cortex_pb.BattleModeInfo` |

The importer reads four tables: `trajectory_meta`,
`trajectory_metadata_blob`, `steps`, `executor_metadata`. The rest are
preserved in the raw `.db` copy but not projected.

## `CortexStepType` enum

The `steps.step_type` column is `exa.cortex_pb.CortexStepType` (116
values). The ones we route on:

| Value | Name | Meaning |
|---|---|---|
| 8 | `VIEW_FILE` | file-read tool call |
| 9 | `LIST_DIRECTORY` | directory listing tool call |
| 14 | `USER_INPUT` | conversation init — user prompt |
| 15 | `PLANNER_RESPONSE` | assistant text reply |
| 17 | `ERROR_MESSAGE` | error event |
| 21 | `RUN_COMMAND` | shell command tool call |
| 23 | `CHECKPOINT` | trajectory checkpoint (boundary) |
| 132 | `GENERIC` | permissions / generic tool call |

All other values fall through to the best-effort branch in
`projectSteps`, where the importer scans for an embedded tool name +
JSON args.

## Per-step projection

`internal/importers/antigravity/parse.go::projectSteps` walks every
row of `steps ORDER BY idx ASC` and emits at most one `session.Turn`
per step:

| `step_type` | Role | `Turn.Kind` | Content source |
|---|---|---|---|
| `USER_INPUT` | `user` | `message` | payload `19→2` (the user prompt) — feeds `FirstPrompt` |
| `PLANNER_RESPONSE` | `assistant` | `message` | payload `20→1` (the model reply text) |
| `CHECKPOINT` | _skipped_ | — | metadata only, no content |
| `VIEW_FILE`, `RUN_COMMAND`, `LIST_DIRECTORY`, `GENERIC`, … | `tool` | `tool_result` | embedded tool-name bareword + JSON args (`{"AbsolutePath":…,"CommandLine":…,"toolAction":…}`) |
| unclassified | best-effort `assistant` | `message` | first scanned string ≥ 16 chars, when present |

`Turn.Timestamp` comes from `CortexStepMetadata.created_at` (field 1).
`StartedAt` falls back to `os.Stat(.db).ModTime()` when no step yields a
parseable timestamp.

## Tool inventory

Counted in the same switch as turn projection. Tool name and JSON args
are extracted from the action sub-messages — e.g. for
`step_type=RUN_COMMAND`, `gemini_coder.Step.run_command` (field 28) holds
the tool call. The importer scans strings depth-recursive for the
bareword tool name + a `{"toolAction":…}` / `{"CommandLine":…}` JSON
span, then aggregates names sorted alphabetically into
`session.ToolUsage`.

## Token usage

`CortexStepMetadata.model_usage` (field 9) carries
`exa.codeium_common_pb.ModelUsageStats`. Recovered field map:

| Field | Meaning |
|---|---|
| 1 | `model_id` enum (e.g. value `1020` = `gemini-3.5-flash-low`) |
| 2 | `input_tokens` (fresh, non-cached prompt input) |
| 3 | `output_tokens` (model response) |
| 4 | `cache_write_tokens` (added to prompt cache this turn) |
| 5 | `cache_read_tokens` (cached portion of the prompt) |
| 9 | `thinking_output_tokens` |
| 10 | `response_output_tokens` |
| 11 | `request_id` string |

The importer aggregates across every step that carries
`model_usage` and surfaces (following the same convention as
claudecode / codex / gemini — `InputTokens` is the full per-call
prompt summed across the trajectory):

- `Session.Usage.InputTokens` = `Σ (input_tokens + cache_read_tokens + cache_write_tokens)`
- `Session.Usage.OutputTokens` = `Σ output_tokens`
- `Session.Usage.CachedTokens` = `Σ cache_read_tokens`
- `Session.Usage.CacheReadTokens` = `Σ cache_read_tokens`
- `Session.Usage.CacheCreationTokens` = `Σ cache_write_tokens`
- `Session.Usage.TotalTokens` = `InputTokens` + `OutputTokens`

In a long agentic session Gemini's prompt cache (system prompt +
tool defs + accumulated history) gets re-read on every turn, so
`Σ cache_read_tokens` represents the same content multiplied by the
number of model calls — an "olá" session with 18 model invocations
and a ~28 KB cached prefix can total ~500 K cache reads on top of
~85 K fresh tokens. `InputTokens` includes that full envelope so
`internal/pricing.CostUSD` can discount the cached portion at the
provider's cache_read rate (≈10× cheaper for Gemini Flash) and still
produce a billing-dashboard-faithful estimate.

`thinking_output_tokens` and `response_output_tokens` are intentionally
NOT plumbed through the canonical session shape — they would split
output tokens further than `pkg/session.TokenUsage` allows today.

## Active sessions

Antigravity holds the writer connection open while the user is in a
session and appends a step to the `.db` after every action.
Consequences:

- Each `prosa sync` while a session is live re-hashes the file, sees a
  different sha256, and re-imports the whole conversation. That is the
  correct behavior — the canonical store reflects the latest version of
  the session.
- The importer reads with DSN `?mode=ro&immutable=1`, so it never
  blocks the writer. Reads see whatever was committed at the last
  fsync.
- As soon as the user closes the antigravity session the file stops
  changing and idempotency kicks in (`sink.LastHash == current hash`
  → skip).

Antigravity uses `PRAGMA page_size = 32768`, larger than SQLite's
default 4 KB. `modernc.org/sqlite` reads this without configuration.

## Notes for prosa importers

- `Walk` returns every `*.db` under root. Zero-byte files are skipped
  (antigravity creates them lazily on the first step).
- Raw preservation copies the `.db` byte-for-byte to
  `$PROSA_HOME/raw/antigravity/<YYYY>/<MM>/<session-id>.db` via the
  standard write-tmp + rename atomic pattern.
- Project identity flows through `internal/projectid.Apply` — same
  helper as every other importer. The git remote in
  `trajectory_metadata_blob` is _not_ used directly; we re-derive it
  from the path so antigravity sessions join cleanly with claudecode /
  codex / gemini sessions on the same repo.
- No legacy v1 bundle predecessor exists for antigravity, so
  `internal/cli/sync.go::importerByLegacyTool` does not list it.
- The `gemini_coder.Step.subtrajectory` field (6) carries a recursive
  `Trajectory` for in-line subagents. The importer does not project
  subagents in the MVP; revisit when subagent usage shows up in real
  sessions.
- See [`../architecture/canonical-session.md`](../architecture/canonical-session.md)
  for the cross-importer mapping contract and
  [`../architecture/importers.md`](../architecture/importers.md) for the
  shared plumbing.

## References

- `google-antigravity/antigravity-sdk-python` — public SDK with
  `localharness_pb2.py` (Apache 2.0).
- `~/.local/bin/agy` — the closed-source Go binary; embedded
  `FileDescriptorProto` for `third_party/gemini_coder/proto/trajectory.proto`,
  `third_party/jetski/cortex_pb/cortex.proto`, and
  `third_party/jetski/codeium_common_pb/codeium_common.proto`.
- Codeium / Windsurf "Cascade" — upstream codebase Antigravity forked
  from; many `exa.*_pb` namespaces are visible in the binary's symbol
  table.
