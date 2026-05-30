package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

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

	res, err := imp.Import(ctx, src, sink)
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.Equal(t, fixtureSessionID, res.SessionID)
	require.NotEmpty(t, res.RawHash)
	require.Greater(t, res.RawSize, int64(0))
	require.FileExists(t, res.RawPath)

	s := sink.sessions[fixtureSessionID]
	require.Equal(t, Name, s.Agent)
	require.Equal(t, "local", s.DeviceID)
	require.NotNil(t, s.ProjectPath)
	require.Equal(t, "/Users/test/proj", *s.ProjectPath)
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "explain entanglement", *s.FirstPrompt)
	require.NotNil(t, s.Model)
	require.Equal(t, "gpt-5-codex", *s.Model)
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
	res2, err := imp.Import(ctx, src, sink)
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

	res, err := imp.Import(ctx, src, sink)
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
