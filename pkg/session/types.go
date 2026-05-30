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
}

// Turn is a single user/assistant message body extracted from a session,
// populated only with the textual signal that drives FTS5. Tool calls,
// tool results, thinking blocks, and operational events are intentionally
// excluded in cut 1 and added when prosa search needs them.
type Turn struct {
	Role      string // "user" | "assistant"
	Content   string
	Timestamp time.Time
}

// ToolUsage aggregates one tool name's invocation count within a session.
// Populated by importers, written to the normalized session_tools table.
type ToolUsage struct {
	Name  string
	Count int
}
