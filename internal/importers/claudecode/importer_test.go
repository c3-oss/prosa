package claudecode

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

	"github.com/c3-oss/prosa/pkg/session"
)

const fixtureSessionID = "12345678-abcd-4ef0-9012-3456789abcde"

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

func writeFixtureSmall(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, fixtureSessionID+".jsonl")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "user",
			"sessionId": fixtureSessionID,
			"timestamp": base.Format(time.RFC3339Nano),
			"cwd":       "/Users/test/proj",
			"message":   map[string]any{"role": "user", "content": "explain quantum entanglement"},
		},
		{
			"type":      "assistant",
			"sessionId": fixtureSessionID,
			"requestId": "req-1",
			"timestamp": base.Add(10 * time.Second).Format(time.RFC3339Nano),
			"cwd":       "/Users/test/proj",
			"message": map[string]any{
				"id":    "msg-1",
				"role":  "assistant",
				"model": "claude-sonnet-4-6",
				"usage": map[string]any{
					"input_tokens":                100,
					"output_tokens":               20,
					"cache_read_input_tokens":     10,
					"cache_creation_input_tokens": 5,
				},
				"content": []map[string]any{
					{"type": "text", "text": "quantum entanglement is when particles share state"},
					{"type": "tool_use", "id": "x1", "name": "Bash", "input": map[string]any{"command": "ls"}},
				},
			},
		},
		{
			"type":      "assistant",
			"sessionId": fixtureSessionID,
			"requestId": "req-1",
			"timestamp": base.Add(20 * time.Second).Format(time.RFC3339Nano),
			"cwd":       "/Users/test/proj",
			"message": map[string]any{
				"id":    "msg-1",
				"role":  "assistant",
				"model": "claude-sonnet-4-6",
				"usage": map[string]any{
					"input_tokens":                100,
					"output_tokens":               20,
					"cache_read_input_tokens":     10,
					"cache_creation_input_tokens": 5,
				},
				"content": []map[string]any{
					{"type": "tool_use", "id": "x2", "name": "Read", "input": map[string]any{"path": "/tmp/x"}},
				},
			},
		},
		{
			"type":      "user",
			"sessionId": fixtureSessionID,
			"timestamp": base.Add(30 * time.Second).Format(time.RFC3339Nano),
			"cwd":       "/Users/test/proj",
			"message": map[string]any{
				"role": "user",
				"content": []map[string]any{
					{"type": "tool_result", "tool_use_id": "x2", "content": "file body"},
				},
			},
		},
	})
	return path
}

func writeFixtureBigLine(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, fixtureSessionID+".jsonl")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	bigPayload := strings.Repeat("x", 8<<20) // 8 MiB
	writeJSONL(t, path, []map[string]any{
		{
			"type": "user", "sessionId": fixtureSessionID,
			"timestamp": base.Format(time.RFC3339Nano), "cwd": "/Users/test/big",
			"message": map[string]any{"role": "user", "content": "go"},
		},
		{
			"type": "assistant", "sessionId": fixtureSessionID,
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"message": map[string]any{
				"role": "assistant", "model": "claude-sonnet-4-6",
				"content": []map[string]any{
					{"type": "tool_use", "id": "x1", "name": "Bash", "input": map[string]any{"command": "cat"}},
					{"type": "tool_result", "tool_use_id": "x1", "content": bigPayload},
				},
			},
		},
	})
	return path
}

func TestImportSmallSession(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	src := writeFixtureSmall(t, t.TempDir())

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
	require.NotEmpty(t, s.DeviceID)
	require.NotEqual(t, "local", s.DeviceID)
	require.NotNil(t, s.ProjectPath)
	require.Equal(t, "/Users/test/proj", *s.ProjectPath)
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "explain quantum entanglement", *s.FirstPrompt)
	require.NotNil(t, s.Model)
	require.Equal(t, "claude-sonnet-4-6", *s.Model)
	require.NotNil(t, s.Usage)
	require.Equal(t, int64(135), s.Usage.TotalTokens)
	require.Equal(t, int64(115), s.Usage.InputTokens)
	require.Equal(t, int64(20), s.Usage.OutputTokens)
	require.Equal(t, int64(10), s.Usage.CachedTokens)
	require.Equal(t, int64(5), s.Usage.CacheCreationTokens)
	require.False(t, s.StartedAt.IsZero())
	require.True(t, s.LastActivityAt.After(s.StartedAt))

	// 1 user text + 1 assistant text + 1 projected tool_result turn.
	turns := sink.turns[fixtureSessionID]
	require.Len(t, turns, 3)
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, session.KindMessage, turns[0].Kind)
	require.Equal(t, "assistant", turns[1].Role)
	require.Equal(t, session.KindMessage, turns[1].Kind)
	require.Equal(t, "tool", turns[2].Role)
	require.Equal(t, session.KindToolResult, turns[2].Kind)
	require.Equal(t, "Read", turns[2].ToolName, "tool name resolved via tool_use_id")
	require.Contains(t, turns[2].Content, "file body")

	// Bash + Read tool uses aggregated.
	tools := sink.tools[fixtureSessionID]
	names := map[string]int{}
	for _, tu := range tools {
		names[tu.Name] = tu.Count
	}
	require.Equal(t, 1, names["Bash"])
	require.Equal(t, 1, names["Read"])

	// Idempotent: second import skips.
	res2, err := imp.Import(ctx, src, sink)
	require.NoError(t, err)
	require.True(t, res2.Skipped)
}

func TestTruncatePreviewKeepsUTF8Valid(t *testing.T) {
	body := strings.Repeat("a", toolPreviewMaxBytes-1) + "é suffix"

	got := truncatePreview(body)

	require.True(t, utf8.ValidString(got))
	require.Contains(t, got, "…")
}

func TestImportBigLineSession(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	src := writeFixtureBigLine(t, t.TempDir())

	info, err := os.Stat(src)
	require.NoError(t, err)
	require.Greater(t, info.Size(), int64(8<<20), "fixture must exceed 8 MiB to exercise buffer")

	sink := newSink()
	imp := New()

	res, err := imp.Import(ctx, src, sink)
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.Equal(t, fixtureSessionID, res.SessionID)
	require.Greater(t, res.RawSize, int64(8<<20))

	// Raw was copied verbatim — destination size matches source.
	dstInfo, err := os.Stat(res.RawPath)
	require.NoError(t, err)
	require.Equal(t, info.Size(), dstInfo.Size())
}

func TestWalkFiltersSubagentsAndNonUUID(t *testing.T) {
	root := t.TempDir()
	proj := filepath.Join(root, "-Users-test-proj")
	require.NoError(t, os.MkdirAll(proj, 0o755))

	valid := filepath.Join(proj, fixtureSessionID+".jsonl")
	require.NoError(t, os.WriteFile(valid, []byte("{}\n"), 0o644))

	subDir := filepath.Join(proj, fixtureSessionID, "subagents")
	require.NoError(t, os.MkdirAll(subDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(subDir, "agent-foo.jsonl"), []byte("{}\n"), 0o644))

	memDir := filepath.Join(proj, "memory")
	require.NoError(t, os.MkdirAll(memDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(memDir, "notes.md"), []byte("x"), 0o644))

	require.NoError(t, os.WriteFile(filepath.Join(proj, "sessions-index.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(proj, "random.jsonl"), []byte("{}"), 0o644))

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

// writeFixtureCaveatWrappedPrompt simulates a Claude Code session
// where the first user message wraps a real prompt inside a
// <local-command-caveat> block. CleanPrompt should strip the wrapper
// so FirstPrompt is the human content.
func writeFixtureCaveatWrappedPrompt(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, fixtureSessionID+".jsonl")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "user",
			"sessionId": fixtureSessionID,
			"timestamp": base.Format(time.RFC3339Nano),
			"cwd":       "/Users/test/proj",
			"message": map[string]any{
				"role":    "user",
				"content": "<local-command-caveat>Caveat: messages generated by the user while running local commands.</local-command-caveat>\nrun the migration",
			},
		},
	})
	return path
}

func TestImportStripsCaveatWrapperForFirstPrompt(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	src := writeFixtureCaveatWrappedPrompt(t, t.TempDir())

	sink := newSink()
	imp := New()
	_, err := imp.Import(ctx, src, sink)
	require.NoError(t, err)
	s := sink.sessions[fixtureSessionID]
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "run the migration", *s.FirstPrompt)

	// The projected user turn carries the cleaned content too.
	turns := sink.turns[fixtureSessionID]
	require.NotEmpty(t, turns)
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, "run the migration", turns[0].Content)
}
