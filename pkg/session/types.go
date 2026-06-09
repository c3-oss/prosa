// Package session defines the canonical domain types every importer maps
// agent-specific session histories into. See docs/canonical-session.md for
// the contract that each importer must satisfy.
package session

import "time"

// Session is the unit prosa lists in its timeline and stores as one row in
// the local SQLite metadata table. The raw transcript (always preserved
// verbatim) is reachable via RawPath.
type Session struct {
	// ID is the agent-assigned session id (e.g. Claude Code's UUID
	// filename). Stable across re-imports of the same file.
	ID string

	// Agent identifies the source ("claude-code", "codex", ...).
	Agent string

	// DeviceID is the prosa device fingerprint. Single-row "local" in cut 1;
	// hash(hostname+machine-id) once sync ships.
	DeviceID string

	// ProjectPath is the cwd captured from the session, when discoverable.
	// Always populated when the session has a cwd; nil only when the
	// importer literally found none.
	ProjectPath *string

	// ProjectRemote is the canonical `git remote get-url origin` URL
	// resolved from ProjectPath at import time. nil when ProjectPath
	// isn't a git repo (or no longer exists on this machine). Stable
	// cross-device.
	ProjectRemote *string

	// ProjectMarker is the `project: <name>` value from a .prosa.yaml in
	// the cwd or any ancestor. nil when no marker is reachable. Explicit
	// override for repos without a shared remote.
	ProjectMarker *string

	// StartedAt is the timestamp of the first record in the JSONL.
	StartedAt time.Time

	// LastActivityAt is the timestamp of the latest record seen. A session
	// is considered active when (now - LastActivityAt) < 10 minutes
	// (INTENT.md §4). There is no separate "ended_at" — the active state
	// is a query, not a stored flag.
	LastActivityAt time.Time

	// FirstPrompt is the first user-authored prompt, truncated to a small
	// number of runes for timeline display. nil when no user prompt parsed.
	FirstPrompt *string

	// Model is the assistant model name encountered first ("claude-sonnet-4-6", ...).
	Model *string

	// RawPath is the absolute path where the preserved verbatim JSONL lives.
	RawPath string

	// RawHash is sha256 of the source file contents at import time. Drives
	// idempotency: re-importing a file with the same hash is a no-op.
	RawHash string

	// RawSize is the byte size of the source file at import time.
	RawSize int64

	// Usage is the token consumption reported by the source agent, when
	// available. Importers leave it nil when the raw transcript does not
	// expose reliable usage counters.
	Usage *TokenUsage

	// ParentSessionID is set on subagent / spawned sessions. Claude
	// Code: parent UUID is the directory above the `subagents/` folder
	// that holds the child JSONL. Codex: parent is
	// `session_meta.payload.source.subagent.thread_spawn.parent_thread_id`.
	// Hermes: parent is `parent_session_id` from state.db or transcript
	// envelopes. nil for top-level sessions.
	ParentSessionID *string
}

// ProjectionVersion identifies the current derived-data projection stored
// alongside the preserved raw transcript. Bump this when importers learn new
// canonical fields from the same raw bytes so sync can refresh old rows even
// when raw_hash did not change.
//
//	v1: original cut.
//	v2: usage projection (session_usage table).
//	v3: turn.kind/tool_name + sessiontext-cleaned FirstPrompt.
//	v4: importer-level no-usage filtering + Claude Code synthetic model exclusion.
//	v5: title sanitization expansion — ANSI escapes stripped from
//	    FirstPrompt/Turn content; <local-command-stdout/stderr> recognized
//	    as boilerplate; cursor/gemini/hermes routed through sessiontext.
//	v6: tri-state usage classification — sessions whose transcript carries
//	    no usage event at all are imported (state Unknown); only sessions
//	    where the importer observed a usage event with explicit zeros are
//	    skipped. Admits cursor sessions and pre-token_count codex sessions
//	    that v5 was silently dropping.
//	v7: thinking blocks projected — Claude Code content[].type=="thinking"
//	    and Codex response_item type=="reasoning" .summary land as
//	    Turn{Role:"assistant", Kind:KindThinking, Content:<truncated>}
//	    so the panel can render them as discrete collapsible blocks.
//	    Excluded from FTS (search results stay focused on chat content).
//	v8: subagent edge captured — Session.ParentSessionID set when a
//	    transcript is a Claude Code subagent (under
//	    `<parent>/subagents/agent-<id>.jsonl`) or a Codex thread spawn
//	    (`session_meta.payload.source.subagent.thread_spawn.parent_thread_id`).
//	    Walked top-down so subagent JSONLs are now imported alongside
//	    their parents.
//	v9: Hermes parent edges projected from state.db `sessions.parent_session_id`
//	    and transcript `parent_session_id` fields.
//	v10: Hermes state.db rows project to per-session canonical JSONL
//	    (one message per line, additive fields for previously hidden
//	    reasoning/codex/tool-call columns). The raw artifact for Hermes
//	    state.db sessions is no longer the full multi-session .db file
//	    but a per-session .jsonl — symmetric with the existing per-session
//	    .jsonl flavor. raw_hash / raw_size now describe the projected
//	    JSONL per session, so sync_reconcile re-pushes Hermes sessions
//	    with their new hashes on first contact.
const ProjectionVersion = 10

// Turn kind constants. Empty Kind is treated as KindMessage so older rows
// and zero-value test fixtures keep working without backfill.
const (
	KindMessage     = "message"
	KindToolResult  = "tool_result"
	KindOperational = "operational"
	KindThinking    = "thinking"
)

// TokenUsage is the canonical token aggregate for one session. InputTokens is
// the provider-reported gross input count; CachedTokens is the public total of
// reusable/cache-hit tokens. CacheReadTokens and CacheCreationTokens are split
// for providers that price those dimensions differently.
type TokenUsage struct {
	TotalTokens         int64
	InputTokens         int64
	OutputTokens        int64
	CachedTokens        int64
	CacheReadTokens     int64
	CacheCreationTokens int64
}

// HasTokenUsage reports whether an imported usage aggregate carries any
// measured token signal. Importers use this as the minimum bar for keeping a
// session in the work log.
func HasTokenUsage(u *TokenUsage) bool {
	return u != nil &&
		(u.TotalTokens > 0 ||
			u.InputTokens > 0 ||
			u.OutputTokens > 0 ||
			u.CachedTokens > 0 ||
			u.CacheReadTokens > 0 ||
			u.CacheCreationTokens > 0)
}

// UsageState classifies what a parser observed about token usage in a
// single transcript. Importers compute it locally at parse time; it is
// never persisted. Three cases:
//
//	UsageStateUnknown      — no usage-bearing event was seen at all
//	                         (cursor by design, older codex transcripts,
//	                         abandoned sessions). The session is admitted
//	                         and stored without a session_usage row.
//	UsageStateExplicitZero — at least one usage event was seen and every
//	                         observed value was zero. The session is skipped
//	                         with reason "no_usage" so the user's worklog
//	                         is not polluted by aborted runs.
//	UsageStatePresent      — at least one usage event reported a positive
//	                         token count. The session is admitted with a
//	                         session_usage row.
type UsageState int

const (
	UsageStateUnknown UsageState = iota
	UsageStateExplicitZero
	UsageStatePresent
)

// ClassifyUsage derives the tri-state from what the parser observed.
// seenUsageEvent is true when at least one usage-bearing event was found
// in the transcript, regardless of whether its values were positive.
func ClassifyUsage(seenUsageEvent bool, usage *TokenUsage) UsageState {
	if HasTokenUsage(usage) {
		return UsageStatePresent
	}
	if seenUsageEvent {
		return UsageStateExplicitZero
	}
	return UsageStateUnknown
}

// Turn is a single message body extracted from a session, populated
// with the textual signal that drives FTS5. Chat content (Role
// "user"/"assistant") arrives with Kind=KindMessage; projected tool
// outputs arrive with Role="tool", Kind=KindToolResult, and ToolName
// set to the originating tool. Reasoning/thinking blocks land as
// Role="assistant", Kind=KindThinking (truncated to a preview); they
// are skipped from FTS so search results stay focused on chat
// content. Binary artifacts remain intentionally excluded.
type Turn struct {
	Role      string // "user" | "assistant" | "tool"
	Content   string
	Timestamp time.Time
	// Kind tags how the importer projected the original record. Empty
	// string is equivalent to KindMessage.
	Kind string
	// ToolName carries the originating tool when Kind=KindToolResult;
	// empty otherwise.
	ToolName string
}

// ToolUsage aggregates one tool name's invocation count within a session.
// Populated by importers, written to the normalized session_tools table.
type ToolUsage struct {
	Name  string
	Count int
}
