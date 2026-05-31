package hermes

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

const (
	jsonlSessionID    = "sess-jsonl-1"
	snapshotSessionID = "sess-snap-1"
)

// inMemSink implements importer.Sink for tests. Copied from the cursor
// test file so the hermes package stays self-contained.
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

func ptrInt64(v int64) *int64 {
	return &v
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

// writeJSONLFixture writes records as one JSON object per line.
func writeJSONLFixture(t *testing.T, path string, records []map[string]any) {
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

// writeSnapshotFixture writes a session_<id>.json envelope.
func writeSnapshotFixture(t *testing.T, path string, env map[string]any) {
	t.Helper()
	b, err := json.MarshalIndent(env, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(path, b, 0o644))
}

// hermesStateRow is a single row used by buildHermesStateDB.
type hermesStateRow struct {
	id        string
	model     string
	startedAt float64
	messages  []hermesStateMessage
}

type hermesStateMessage struct {
	role       string
	content    string
	toolCalls  string
	timestamp  float64
	tokenCount *int64
}

// buildHermesStateDB writes a state.db with the Hermes schema, populated
// with the supplied session rows.
func buildHermesStateDB(t *testing.T, dir string, rows []hermesStateRow) string {
	t.Helper()
	require.NoError(t, os.MkdirAll(dir, 0o755))
	dbPath := filepath.Join(dir, "state.db")

	db, err := sql.Open("sqlite", dbPath)
	require.NoError(t, err)
	defer func() { _ = db.Close() }()

	_, err = db.Exec(`
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  model TEXT,
  model_config TEXT,
  system_prompt TEXT,
  parent_session_id TEXT,
  started_at REAL NOT NULL,
  ended_at REAL,
  end_reason TEXT,
  message_count INTEGER,
  tool_call_count INTEGER,
  title TEXT
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  timestamp REAL NOT NULL,
  token_count INTEGER,
  finish_reason TEXT,
  reasoning TEXT,
  reasoning_content TEXT,
  reasoning_details TEXT,
  codex_reasoning_items TEXT,
  codex_message_items TEXT
);`)
	require.NoError(t, err)

	for _, r := range rows {
		_, err = db.Exec(
			`INSERT INTO sessions(id, source, model, started_at, message_count) VALUES (?, ?, ?, ?, ?)`,
			r.id, "cli", r.model, r.startedAt, len(r.messages),
		)
		require.NoError(t, err)
		for _, m := range r.messages {
			_, err = db.Exec(
				`INSERT INTO messages(session_id, role, content, tool_calls, timestamp, token_count) VALUES (?, ?, ?, ?, ?, ?)`,
				r.id, m.role, m.content, m.toolCalls, m.timestamp, m.tokenCount,
			)
			require.NoError(t, err)
		}
	}
	return dbPath
}

func TestWalkFindsAllFlavors(t *testing.T) {
	root := t.TempDir()
	hermesHome := filepath.Join(root, ".hermes")
	sessionsDir := filepath.Join(hermesHome, "sessions")
	savedDir := filepath.Join(sessionsDir, "saved")
	require.NoError(t, os.MkdirAll(savedDir, 0o755))

	stateDB := filepath.Join(hermesHome, "state.db")
	require.NoError(t, os.WriteFile(stateDB, []byte("dbbytes"), 0o644))

	jsonlPath := filepath.Join(sessionsDir, "sess-1.jsonl")
	require.NoError(t, os.WriteFile(jsonlPath, []byte("{}\n"), 0o644))

	snapPath := filepath.Join(sessionsDir, "session_sess-2.json")
	require.NoError(t, os.WriteFile(snapPath, []byte("{}"), 0o644))

	// Skipped files / dirs:
	require.NoError(t, os.WriteFile(filepath.Join(sessionsDir, "sessions.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(sessionsDir, "garbage.txt"), []byte("x"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(savedDir, "foo.jsonl"), []byte("{}"), 0o644))

	imp := New()
	got, err := imp.Walk(context.Background(), sessionsDir)
	require.NoError(t, err)

	sort.Strings(got)
	want := []string{stateDB, jsonlPath, snapPath}
	sort.Strings(want)
	require.Equal(t, want, got)
}

func TestWalkMissingRootReturnsEmpty(t *testing.T) {
	imp := New()
	got, err := imp.Walk(context.Background(), filepath.Join(t.TempDir(), "nope"))
	require.NoError(t, err)
	require.Empty(t, got)
}

func TestImportJSONL(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	sessionsDir := filepath.Join(t.TempDir(), ".hermes", "sessions")
	require.NoError(t, os.MkdirAll(sessionsDir, 0o755))
	src := filepath.Join(sessionsDir, jsonlSessionID+".jsonl")

	base := time.Date(2026, 3, 14, 12, 0, 0, 0, time.UTC)
	writeJSONLFixture(t, src, []map[string]any{
		{
			"role":        "user",
			"content":     "explain quantum entanglement",
			"timestamp":   float64(base.Unix()),
			"token_count": 5,
		},
		{
			"role":        "assistant",
			"content":     "two particles share state",
			"timestamp":   float64(base.Add(10 * time.Second).Unix()),
			"model":       "claude-sonnet-4-6",
			"token_count": 17,
			"tool_calls": []map[string]any{
				{"name": "Read"},
				{"name": "Bash"},
				{"name": "Read"},
			},
		},
	})

	sink := newSink()
	imp := New()

	res, err := imp.Import(ctx, src, sink)
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.Equal(t, jsonlSessionID, res.SessionID)
	require.NotEmpty(t, res.RawHash)
	require.Greater(t, res.RawSize, int64(0))
	require.FileExists(t, res.RawPath)

	s := sink.sessions[jsonlSessionID]
	require.Equal(t, Name, s.Agent)
	require.NotEmpty(t, s.DeviceID)
	require.NotEqual(t, "local", s.DeviceID)
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "explain quantum entanglement", *s.FirstPrompt)
	require.NotNil(t, s.Model)
	require.Equal(t, "claude-sonnet-4-6", *s.Model)
	require.NotNil(t, s.Usage)
	require.Equal(t, int64(22), s.Usage.TotalTokens)
	require.Equal(t, 2026, s.StartedAt.Year())
	require.Equal(t, time.March, s.StartedAt.Month())
	require.True(t, s.LastActivityAt.After(s.StartedAt))

	turns := sink.turns[jsonlSessionID]
	require.Len(t, turns, 2)
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, "explain quantum entanglement", turns[0].Content)
	require.Equal(t, "assistant", turns[1].Role)
	require.Equal(t, "two particles share state", turns[1].Content)

	tools := sink.tools[jsonlSessionID]
	require.Len(t, tools, 2)
	byName := map[string]int{}
	for _, tl := range tools {
		byName[tl.Name] = tl.Count
	}
	require.Equal(t, 2, byName["Read"])
	require.Equal(t, 1, byName["Bash"])

	res2, err := imp.Import(ctx, src, sink)
	require.NoError(t, err)
	require.True(t, res2.Skipped)
}

func TestImportSnapshot(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	sessionsDir := filepath.Join(t.TempDir(), ".hermes", "sessions")
	require.NoError(t, os.MkdirAll(sessionsDir, 0o755))
	src := filepath.Join(sessionsDir, "session_"+snapshotSessionID+".json")

	base := time.Date(2026, 4, 1, 9, 30, 0, 0, time.UTC)
	writeSnapshotFixture(t, src, map[string]any{
		"session_id":    snapshotSessionID,
		"session_start": base.Format(time.RFC3339Nano),
		"last_updated":  base.Add(time.Minute).Format(time.RFC3339Nano),
		"platform":      "anthropic",
		"model":         "claude-opus-4-7",
		"system_prompt": "you are helpful",
		"messages": []map[string]any{
			{"role": "user", "content": "hello world"},
			{
				"role": "assistant", "content": "hi there", "token_count": 17,
				"tool_calls": []map[string]any{{"name": "Edit"}},
			},
		},
	})

	sink := newSink()
	imp := New()

	res, err := imp.Import(ctx, src, sink)
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.Equal(t, snapshotSessionID, res.SessionID)
	require.NotEmpty(t, res.RawHash)
	require.FileExists(t, res.RawPath)

	s := sink.sessions[snapshotSessionID]
	require.Equal(t, Name, s.Agent)
	require.NotEmpty(t, s.DeviceID)
	require.NotEqual(t, "local", s.DeviceID)
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "hello world", *s.FirstPrompt)
	require.NotNil(t, s.Model)
	require.Equal(t, "claude-opus-4-7", *s.Model)
	require.Equal(t, base.UTC(), s.StartedAt)
	require.Equal(t, base.Add(time.Minute).UTC(), s.LastActivityAt)

	turns := sink.turns[snapshotSessionID]
	require.Len(t, turns, 2)
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, "assistant", turns[1].Role)

	tools := sink.tools[snapshotSessionID]
	require.Len(t, tools, 1)
	require.Equal(t, "Edit", tools[0].Name)
	require.Equal(t, 1, tools[0].Count)

	res2, err := imp.Import(ctx, src, sink)
	require.NoError(t, err)
	require.True(t, res2.Skipped)
}

func TestImportStateDB(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	hermesHome := filepath.Join(t.TempDir(), ".hermes")
	require.NoError(t, os.MkdirAll(filepath.Join(hermesHome, "sessions"), 0o755))

	base := time.Date(2026, 5, 30, 6, 0, 0, 0, time.UTC)
	rows := []hermesStateRow{
		{
			id:        "state-1",
			model:     "claude-sonnet-4-6",
			startedAt: float64(base.Unix()),
			messages: []hermesStateMessage{
				{role: "user", content: "first prompt one", timestamp: float64(base.Unix())},
				{
					role: "assistant", content: "answer one",
					timestamp:  float64(base.Add(5 * time.Second).Unix()),
					toolCalls:  `[{"name":"Read"}]`,
					tokenCount: ptrInt64(17),
				},
			},
		},
		{
			id:        "state-2",
			model:     "claude-opus-4-7",
			startedAt: float64(base.Add(time.Hour).Unix()),
			messages: []hermesStateMessage{
				{role: "user", content: "second prompt", timestamp: float64(base.Add(time.Hour).Unix())},
				{
					role: "assistant", content: "second answer",
					timestamp:  float64(base.Add(time.Hour + 5*time.Second).Unix()),
					tokenCount: ptrInt64(19),
				},
			},
		},
	}
	dbPath := buildHermesStateDB(t, hermesHome, rows)

	sink := newSink()
	imp := New()

	res, err := imp.Import(ctx, dbPath, sink)
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.NotEmpty(t, res.RawHash)

	require.Contains(t, sink.sessions, "state-1")
	require.Contains(t, sink.sessions, "state-2")

	s1 := sink.sessions["state-1"]
	require.Equal(t, Name, s1.Agent)
	require.NotEmpty(t, s1.DeviceID)
	require.NotEqual(t, "local", s1.DeviceID)
	require.NotNil(t, s1.FirstPrompt)
	require.Equal(t, "first prompt one", *s1.FirstPrompt)
	require.NotNil(t, s1.Model)
	require.Equal(t, "claude-sonnet-4-6", *s1.Model)
	require.Len(t, sink.turns["state-1"], 2)
	require.Len(t, sink.tools["state-1"], 1)
	require.Equal(t, "Read", sink.tools["state-1"][0].Name)

	s2 := sink.sessions["state-2"]
	require.NotNil(t, s2.Model)
	require.Equal(t, "claude-opus-4-7", *s2.Model)
	require.Len(t, sink.turns["state-2"], 2)

	res2, err := imp.Import(ctx, dbPath, sink)
	require.NoError(t, err)
	require.True(t, res2.Skipped)
}

func TestStateDBMergeYieldsToTranscript(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	hermesHome := filepath.Join(t.TempDir(), ".hermes")
	sessionsDir := filepath.Join(hermesHome, "sessions")
	require.NoError(t, os.MkdirAll(sessionsDir, 0o755))

	base := time.Date(2026, 5, 30, 7, 0, 0, 0, time.UTC)
	rows := []hermesStateRow{
		{
			id:        "S",
			model:     "claude-sonnet-4-6",
			startedAt: float64(base.Unix()),
			messages: []hermesStateMessage{
				{role: "user", content: "state truncated", timestamp: float64(base.Unix())},
			},
		},
	}
	dbPath := buildHermesStateDB(t, hermesHome, rows)

	jsonlPath := filepath.Join(sessionsDir, "S.jsonl")
	writeJSONLFixture(t, jsonlPath, []map[string]any{
		{"role": "user", "content": "richer first prompt", "timestamp": float64(base.Unix())},
		{
			"role": "assistant", "content": "richer reply",
			"timestamp":   float64(base.Add(5 * time.Second).Unix()),
			"model":       "claude-sonnet-4-6",
			"token_count": 17,
		},
		{
			"role": "user", "content": "follow-up",
			"timestamp": float64(base.Add(10 * time.Second).Unix()),
		},
	})

	sink := newSink()
	imp := New()

	// state.db import must skip S because the sibling jsonl has more messages.
	res, err := imp.Import(ctx, dbPath, sink)
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.NotContains(t, sink.sessions, "S", "state.db Import must defer to sibling transcript")

	// File-shaped Import call projects S normally.
	res2, err := imp.Import(ctx, jsonlPath, sink)
	require.NoError(t, err)
	require.False(t, res2.Skipped)
	require.Equal(t, "S", res2.SessionID)

	s := sink.sessions["S"]
	require.Equal(t, Name, s.Agent)
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "richer first prompt", *s.FirstPrompt)
	require.Len(t, sink.turns["S"], 3) // user + assistant + user
}

// TestImportJSONLSanitizesFirstPrompt covers the bug where hermes user
// records carrying ANSI escapes and/or <local-command-stdout> wrappers
// leaked into FirstPrompt as garbled bytes.
func TestImportJSONLSanitizesFirstPrompt(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	sessionsDir := filepath.Join(t.TempDir(), ".hermes", "sessions")
	require.NoError(t, os.MkdirAll(sessionsDir, 0o755))
	src := filepath.Join(sessionsDir, "sess-dirty.jsonl")

	base := time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC)
	dirtyText := "<local-command-stdout>Set model to \x1b[1mclaude\x1b[22m</local-command-stdout>\n" +
		"now refactor the sync"
	writeJSONLFixture(t, src, []map[string]any{
		{"role": "user", "content": dirtyText, "timestamp": float64(base.Unix()), "token_count": 5},
		{"role": "assistant", "content": "ok", "timestamp": float64(base.Add(time.Second).Unix()), "model": "claude-sonnet-4-6", "token_count": 1},
	})

	sink := newSink()
	res, err := New().Import(ctx, src, sink)
	require.NoError(t, err)
	require.False(t, res.Skipped)
	s := sink.sessions["sess-dirty"]
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "now refactor the sync", *s.FirstPrompt)
}
