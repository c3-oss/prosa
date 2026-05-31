package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/importer"
	"github.com/c3-oss/prosa/pkg/session"
)

const fixtureSessionID = "019c537c-493c-7a11-b1ef-6e742bf9f7d1"

// codexFixtureFilename returns a filename matching the codexFileRE pattern
// for the given UTC time and session id.
func codexFixtureFilename(t time.Time, id string) string {
	return "rollout-" + t.UTC().Format("2006-01-02T15-04-05") + "-" + id + ".jsonl"
}

// inMemSink implements importer.Sink for tests.
type inMemSink struct {
	sessions map[string]session.Session
	tools    map[string][]session.ToolUsage
	turns    map[string][]session.Turn
	hashes   map[string]string
}

func newSink() *inMemSink {
	return &inMemSink{
		sessions: map[string]session.Session{},
		tools:    map[string][]session.ToolUsage{},
		turns:    map[string][]session.Turn{},
		hashes:   map[string]string{},
	}
}

func (m *inMemSink) UpsertSession(_ context.Context, s session.Session, tools []session.ToolUsage) error {
	m.sessions[s.ID] = s
	m.tools[s.ID] = tools
	return nil
}

func (m *inMemSink) InsertTurns(_ context.Context, sid string, t []session.Turn) error {
	m.turns[sid] = t
	return nil
}

func (m *inMemSink) LastHash(_ context.Context, sid string) (string, bool, error) {
	h, ok := m.hashes[sid]
	return h, ok, nil
}

func (m *inMemSink) RecordSync(_ context.Context, sid, h string) error {
	m.hashes[sid] = h
	return nil
}

func writeJSONL(t *testing.T, path string, records []map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	for _, r := range records {
		b, err := json.Marshal(r)
		require.NoError(t, err)
		buf.Write(b)
		buf.WriteByte('\n')
	}
	require.NoError(t, os.WriteFile(path, buf.Bytes(), 0o644))
}

// writeFixtureEnvelope generates a modern (envelope-shaped) Codex session
// in the day-sharded directory layout the real importer walks.
func writeFixtureEnvelope(t *testing.T, root string) string {
	t.Helper()
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	dir := filepath.Join(root, base.Format("2006"), base.Format("01"), base.Format("02"))
	require.NoError(t, os.MkdirAll(dir, 0o755))

	path := filepath.Join(dir, codexFixtureFilename(base, fixtureSessionID))
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "session_meta",
			"timestamp": base.Format(time.RFC3339Nano),
			"payload": map[string]any{
				"id":         fixtureSessionID,
				"timestamp":  base.Format(time.RFC3339Nano),
				"cwd":        "/Users/test/proj",
				"originator": "codex_cli_rs",
			},
		},
		{
			"type":      "turn_context",
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"model": "gpt-5-codex",
				"cwd":   "/Users/test/proj",
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(5 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "message", "role": "user",
				"content": []map[string]any{{"type": "input_text", "text": "explain entanglement"}},
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(10 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "message", "role": "assistant",
				"content": []map[string]any{{"type": "output_text", "text": "particles share state across distance"}},
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(15 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "function_call", "name": "shell", "call_id": "c1", "arguments": `{"command":"ls"}`,
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(20 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "function_call", "name": "shell", "call_id": "c2", "arguments": `{"command":"pwd"}`,
			},
		},
		{
			"type":      "event_msg",
			"timestamp": base.Add(25 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "exec_command_end", "call_id": "c1", "exit_code": 0,
				"stdout": "file1\nfile2", "stderr": "", "duration": 12,
			},
		},
		{
			"type":      "event_msg",
			"timestamp": base.Add(26 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "token_count",
				"info": map[string]any{
					"total_token_usage": map[string]any{
						"input_tokens":        1000,
						"cached_input_tokens": 250,
						"output_tokens":       120,
						"total_tokens":        1120,
					},
				},
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(30 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "message", "role": "developer",
				"content": []map[string]any{{"type": "input_text", "text": "system-instruction"}},
			},
		},
	})
	return path
}

// writeFixtureLegacy generates a pre-envelope Codex session with bare
// top-level records to confirm the parser handles the older shape too.
func writeFixtureLegacy(t *testing.T, root string) string {
	t.Helper()
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	dir := filepath.Join(root, base.Format("2006"), base.Format("01"), base.Format("02"))
	require.NoError(t, os.MkdirAll(dir, 0o755))

	// Legacy files may lack session_meta — id falls back to filename UUID.
	path := filepath.Join(dir, codexFixtureFilename(base, fixtureSessionID))
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "message",
			"timestamp": base.Format(time.RFC3339Nano),
			"role":      "user",
			"content":   "legacy plain string content",
		},
		{
			"type":      "message",
			"timestamp": base.Add(5 * time.Second).Format(time.RFC3339Nano),
			"role":      "assistant",
			"content":   []map[string]any{{"text": "legacy assistant reply"}},
		},
		{
			"type":      "function_call",
			"timestamp": base.Add(10 * time.Second).Format(time.RFC3339Nano),
			"name":      "legacy_tool",
		},
		{
			"type":      "event_msg",
			"timestamp": base.Add(15 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "token_count",
				"info": map[string]any{
					"total_token_usage": map[string]any{
						"input_tokens":  10,
						"output_tokens": 2,
						"total_tokens":  12,
					},
				},
			},
		},
	})
	return path
}

func TestImportEnvelopeSession(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "codex-root")
	src := writeFixtureEnvelope(t, root)

	sink := newSink()
	imp := New()

	res, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.Equal(t, fixtureSessionID, res.SessionID)
	require.NotEmpty(t, res.RawHash)
	require.Greater(t, res.RawSize, int64(0))
	require.FileExists(t, res.RawPath)

	s := sink.sessions[fixtureSessionID]
	require.Equal(t, Name, s.Agent)
	require.NotEmpty(t, s.DeviceID)
	require.NotEqual(t, "local", s.DeviceID)
	require.NotNil(t, s.ProjectPath)
	require.Equal(t, "/Users/test/proj", *s.ProjectPath)
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "explain entanglement", *s.FirstPrompt)
	require.NotNil(t, s.Model)
	require.Equal(t, "gpt-5-codex", *s.Model)
	require.NotNil(t, s.Usage)
	require.Equal(t, int64(1120), s.Usage.TotalTokens)
	require.Equal(t, int64(1000), s.Usage.InputTokens)
	require.Equal(t, int64(120), s.Usage.OutputTokens)
	require.Equal(t, int64(250), s.Usage.CachedTokens)
	require.False(t, s.StartedAt.IsZero())
	require.True(t, s.LastActivityAt.After(s.StartedAt))

	// User + assistant text turns; developer role is intentionally skipped.
	turns := sink.turns[fixtureSessionID]
	require.Len(t, turns, 2)
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, "assistant", turns[1].Role)

	// One tool name with two invocations.
	tools := sink.tools[fixtureSessionID]
	require.Len(t, tools, 1)
	require.Equal(t, "shell", tools[0].Name)
	require.Equal(t, 2, tools[0].Count)

	// Idempotent: second import skips.
	res2, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.True(t, res2.Skipped)
}

func TestImportLegacySession(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "codex-root")
	src := writeFixtureLegacy(t, root)

	sink := newSink()
	imp := New()

	res, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)
	// No session_meta in legacy file -> id from filename UUID.
	require.Equal(t, fixtureSessionID, res.SessionID)

	s := sink.sessions[fixtureSessionID]
	require.Equal(t, Name, s.Agent)
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "legacy plain string content", *s.FirstPrompt)

	turns := sink.turns[fixtureSessionID]
	require.Len(t, turns, 2)
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, "legacy plain string content", turns[0].Content)
	require.Equal(t, "assistant", turns[1].Role)
	require.Equal(t, "legacy assistant reply", turns[1].Content)

	tools := sink.tools[fixtureSessionID]
	require.Len(t, tools, 1)
	require.Equal(t, "legacy_tool", tools[0].Name)
}

// TestImportSetsParentSessionIDFromThreadSpawn confirms the importer
// captures Codex's `session_meta.payload.source.subagent.thread_spawn.parent_thread_id`
// into the canonical session's ParentSessionID. Sessions without the
// payload stay parent-less so existing fixtures keep round-tripping.
func TestImportSetsParentSessionIDFromThreadSpawn(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "codex-root")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	dir := filepath.Join(root, base.Format("2006"), base.Format("01"), base.Format("02"))
	require.NoError(t, os.MkdirAll(dir, 0o755))
	path := filepath.Join(dir, codexFixtureFilename(base, fixtureSessionID))
	parentThread := "11111111-2222-4333-8444-555555555555"
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "session_meta",
			"timestamp": base.Format(time.RFC3339Nano),
			"payload": map[string]any{
				"id":  fixtureSessionID,
				"cwd": "/proj",
				"source": map[string]any{
					"subagent": map[string]any{
						"thread_spawn": map[string]any{
							"parent_thread_id": parentThread,
						},
					},
				},
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "message", "role": "user",
				"content": []map[string]any{{"type": "input_text", "text": "go"}},
			},
		},
		{
			"type":      "event_msg",
			"timestamp": base.Add(2 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "token_count",
				"info": map[string]any{
					"total_token_usage": map[string]any{
						"input_tokens": 1, "output_tokens": 1, "total_tokens": 2,
					},
				},
			},
		},
	})

	sink := newSink()
	res, err := New().Import(ctx, path, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)

	got := sink.sessions[fixtureSessionID]
	require.NotNil(t, got.ParentSessionID,
		"thread_spawn.parent_thread_id must populate ParentSessionID")
	require.Equal(t, parentThread, *got.ParentSessionID)
}

// TestImportProjectsReasoningSummary verifies that a Codex reasoning
// item with a `summary` payload lands as a KindThinking turn. Both
// plain-string and block-list summary shapes are accepted; an empty
// or summary-less reasoning item (encrypted_content only) is dropped.
func TestImportProjectsReasoningSummary(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "codex-root")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	dir := filepath.Join(root, base.Format("2006"), base.Format("01"), base.Format("02"))
	require.NoError(t, os.MkdirAll(dir, 0o755))
	path := filepath.Join(dir, codexFixtureFilename(base, fixtureSessionID))
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "session_meta",
			"timestamp": base.Format(time.RFC3339Nano),
			"payload": map[string]any{
				"id":  fixtureSessionID,
				"cwd": "/Users/test/proj",
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "message", "role": "user",
				"content": []map[string]any{{"type": "input_text", "text": "do it"}},
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(2 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type":    "reasoning",
				"summary": "plain string reasoning",
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(3 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "reasoning",
				"summary": []map[string]any{
					{"type": "summary_text", "text": "block one"},
					{"type": "summary_text", "text": "block two"},
				},
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(4 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type":              "reasoning",
				"encrypted_content": "opaque-blob",
				// no summary → must NOT project a thinking turn
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(5 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "message", "role": "assistant",
				"content": []map[string]any{{"type": "output_text", "text": "done"}},
			},
		},
		{
			"type":      "event_msg",
			"timestamp": base.Add(6 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "token_count",
				"info": map[string]any{
					"total_token_usage": map[string]any{
						"input_tokens":  10,
						"output_tokens": 2,
						"total_tokens":  12,
					},
				},
			},
		},
	})

	sink := newSink()
	res, err := New().Import(ctx, path, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)

	turns := sink.turns[fixtureSessionID]
	// user message + 2 thinking + assistant message
	require.Len(t, turns, 4)
	require.Equal(t, session.KindMessage, turns[0].Kind)
	require.Equal(t, session.KindThinking, turns[1].Kind)
	require.Equal(t, "assistant", turns[1].Role)
	require.Equal(t, "plain string reasoning", turns[1].Content)
	require.Equal(t, session.KindThinking, turns[2].Kind)
	require.Equal(t, "block one\nblock two", turns[2].Content)
	require.Equal(t, session.KindMessage, turns[3].Kind)
}

// TestImportAdmitsSessionWithoutUsageEvent covers a codex transcript
// that never emits a `token_count` event (older codex rollouts before
// usage reporting landed). Under tri-state classification this is
// UsageStateUnknown and the importer admits the session; sess.Usage
// stays nil and the session lives in the timeline without a cost row.
func TestImportAdmitsSessionWithoutUsageEvent(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "codex-root")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	dir := filepath.Join(root, base.Format("2006"), base.Format("01"), base.Format("02"))
	require.NoError(t, os.MkdirAll(dir, 0o755))
	path := filepath.Join(dir, codexFixtureFilename(base, fixtureSessionID))
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "session_meta",
			"timestamp": base.Format(time.RFC3339Nano),
			"payload": map[string]any{
				"id":  fixtureSessionID,
				"cwd": "/Users/test/proj",
			},
		},
		{
			"type":      "turn_context",
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"model": "gpt-5-codex",
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(2 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "message", "role": "user",
				"content": []map[string]any{{"type": "input_text", "text": "hi"}},
			},
		},
	})

	sink := newSink()
	res, err := New().Import(ctx, path, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped,
		"transcripts without any token_count event must admit (Unknown state)")
	require.Empty(t, res.SkipReason)
	require.Contains(t, sink.sessions, fixtureSessionID)
	stored := sink.sessions[fixtureSessionID]
	require.Nil(t, stored.Usage,
		"sess.Usage must be nil when no token_count event was observed")
}

// TestImportSkipsSessionWithExplicitZeroUsage covers a transcript that
// emits a token_count event with all-zero totals. The classifier marks
// this UsageStateExplicitZero and the importer skips with no_usage.
func TestImportSkipsSessionWithExplicitZeroUsage(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "codex-root")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	dir := filepath.Join(root, base.Format("2006"), base.Format("01"), base.Format("02"))
	require.NoError(t, os.MkdirAll(dir, 0o755))
	path := filepath.Join(dir, codexFixtureFilename(base, fixtureSessionID))
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "session_meta",
			"timestamp": base.Format(time.RFC3339Nano),
			"payload": map[string]any{
				"id":  fixtureSessionID,
				"cwd": "/Users/test/proj",
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "message", "role": "user",
				"content": []map[string]any{{"type": "input_text", "text": "hi"}},
			},
		},
		{
			"type":      "event_msg",
			"timestamp": base.Add(2 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "token_count",
				"info": map[string]any{
					"total_token_usage": map[string]any{
						"input_tokens":  0,
						"output_tokens": 0,
						"total_tokens":  0,
					},
				},
			},
		},
	})

	sink := newSink()
	res, err := New().Import(ctx, path, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.True(t, res.Skipped)
	require.Equal(t, "no_usage", res.SkipReason)
	require.Empty(t, sink.sessions)
	require.Empty(t, sink.turns)
	require.Empty(t, res.RawPath)
}

func TestWalkAcceptsRolloutPatternOnly(t *testing.T) {
	root := t.TempDir()
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	day := filepath.Join(root, base.Format("2006"), base.Format("01"), base.Format("02"))
	require.NoError(t, os.MkdirAll(day, 0o755))

	valid := filepath.Join(day, codexFixtureFilename(base, fixtureSessionID))
	require.NoError(t, os.WriteFile(valid, []byte("{}\n"), 0o644))

	// Anything not matching the rollout-* pattern is skipped.
	require.NoError(t, os.WriteFile(filepath.Join(day, "random.jsonl"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(day, "rollout-bad-name.jsonl"), []byte("{}"), 0o644))

	imp := New()
	got, err := imp.Walk(context.Background(), root)
	require.NoError(t, err)
	require.Equal(t, []string{valid}, got)
}

func TestWalkMissingRootReturnsEmpty(t *testing.T) {
	imp := New()
	got, err := imp.Walk(context.Background(), filepath.Join(t.TempDir(), "nonexistent"))
	require.NoError(t, err)
	require.Empty(t, got)
}

// writeFixtureBoilerplateFirstPrompt simulates a Codex session where
// the first user-role message is a system-style preamble that should
// not become the session's FirstPrompt.
func writeFixtureBoilerplateFirstPrompt(t *testing.T, root string) string {
	t.Helper()
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	dir := filepath.Join(root, base.Format("2006"), base.Format("01"), base.Format("02"))
	require.NoError(t, os.MkdirAll(dir, 0o755))
	path := filepath.Join(dir, codexFixtureFilename(base, fixtureSessionID))
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "session_meta",
			"timestamp": base.Format(time.RFC3339Nano),
			"payload":   map[string]any{"id": fixtureSessionID, "cwd": "/tmp"},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "message", "role": "user",
				"content": []map[string]any{{"type": "input_text", "text": "You are Codex, a coding agent. Knowledge cutoff: 2025-04."}},
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(2 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "message", "role": "user",
				"content": []map[string]any{{"type": "input_text", "text": "deploy the staging branch"}},
			},
		},
		{
			"type":      "event_msg",
			"timestamp": base.Add(3 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "token_count",
				"info": map[string]any{
					"total_token_usage": map[string]any{
						"input_tokens": 10,
						"total_tokens": 10,
					},
				},
			},
		},
	})
	return path
}

func TestImportSkipsBoilerplateForFirstPrompt(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	root := filepath.Join(t.TempDir(), "codex-root")
	src := writeFixtureBoilerplateFirstPrompt(t, root)

	sink := newSink()
	imp := New()
	_, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	s := sink.sessions[fixtureSessionID]
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "deploy the staging branch", *s.FirstPrompt)
}

// writeFixtureFunctionOutput exercises the new function_call_output
// projection: the importer should turn it into a tool-role Turn with
// Kind=tool_result, ToolName resolved via call_id, and the content
// truncated to the preview limits.
func writeFixtureFunctionOutput(t *testing.T, root string) string {
	t.Helper()
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	dir := filepath.Join(root, base.Format("2006"), base.Format("01"), base.Format("02"))
	require.NoError(t, os.MkdirAll(dir, 0o755))
	path := filepath.Join(dir, codexFixtureFilename(base, fixtureSessionID))
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "session_meta",
			"timestamp": base.Format(time.RFC3339Nano),
			"payload":   map[string]any{"id": fixtureSessionID, "cwd": "/tmp"},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "message", "role": "user",
				"content": []map[string]any{{"type": "input_text", "text": "do the thing"}},
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(2 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "function_call", "name": "shell", "call_id": "c1", "arguments": `{"command":"ls"}`,
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(3 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "function_call_output", "call_id": "c1",
				"output": "stdout:\nfile1\nfile2",
			},
		},
		{
			"type":      "event_msg",
			"timestamp": base.Add(4 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "token_count",
				"info": map[string]any{
					"total_token_usage": map[string]any{
						"input_tokens": 10,
						"total_tokens": 10,
					},
				},
			},
		},
	})
	return path
}

func TestImportProjectsFunctionCallOutputAsToolTurn(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	root := filepath.Join(t.TempDir(), "codex-root")
	src := writeFixtureFunctionOutput(t, root)

	sink := newSink()
	imp := New()
	_, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)

	turns := sink.turns[fixtureSessionID]
	require.Len(t, turns, 2, "user message + tool result projection")
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, session.KindMessage, turns[0].Kind)

	tool := turns[1]
	require.Equal(t, "tool", tool.Role)
	require.Equal(t, session.KindToolResult, tool.Kind)
	require.Equal(t, "shell", tool.ToolName)
	require.Contains(t, tool.Content, "file1")
}

func TestTruncatePreviewKeepsUTF8Valid(t *testing.T) {
	body := strings.Repeat("a", toolPreviewMaxBytes-1) + "é suffix"

	got := truncatePreview(body)

	require.True(t, utf8.ValidString(got))
	require.Contains(t, got, "…")
}
