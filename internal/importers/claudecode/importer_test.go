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

	"github.com/c3-oss/prosa/internal/importers/importertest"
	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/pkg/importer"
	"github.com/c3-oss/prosa/pkg/session"
)

const fixtureSessionID = "12345678-abcd-4ef0-9012-3456789abcde"

func newSink() *importertest.Sink {
	return importertest.NewSink()
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
				"usage": map[string]any{
					"input_tokens":  1,
					"output_tokens": 1,
				},
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

	res, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.Equal(t, fixtureSessionID, res.SessionID)
	require.NotEmpty(t, res.RawHash)
	require.Greater(t, res.RawSize, int64(0))
	require.FileExists(t, res.RawPath)

	s := sink.Sessions[fixtureSessionID]
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
	turns := sink.Turns[fixtureSessionID]
	require.Len(t, turns, 3)
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, session.KindMessage, turns[0].Kind)
	require.Equal(t, "assistant", turns[1].Role)
	require.Equal(t, session.KindMessage, turns[1].Kind)
	require.Equal(t, "tool", turns[2].Role)
	require.Equal(t, session.KindToolResult, turns[2].Kind)
	require.Equal(t, "Read", turns[2].ToolName, "tool name resolved via tool_use_id")
	require.Contains(t, turns[2].Content, "file body")

	tools := sink.Tools[fixtureSessionID]
	names := map[string]int{}
	for _, tu := range tools {
		names[tu.Name] = tu.Count
	}
	require.Equal(t, 1, names["Bash"])
	require.Equal(t, 1, names["Read"])

	res2, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.True(t, res2.Skipped)

	// --overwrite bypasses the idempotency short-circuit: same file,
	// same hash, but the importer re-parses and re-upserts. Used by
	// `prosa sync --overwrite` to rebuild a converged store.
	res3, err := imp.Import(ctx, src, sink, importer.ImportOptions{Overwrite: true})
	require.NoError(t, err)
	require.False(t, res3.Skipped,
		"--overwrite must bypass LastHash check and force a fresh import")
	require.Equal(t, res.SessionID, res3.SessionID)
}

func TestTruncatePreviewKeepsUTF8Valid(t *testing.T) {
	t.Parallel()
	body := strings.Repeat("a", importerutil.ToolPreviewMaxBytes-1) + "é suffix"

	got := importerutil.TruncatePreview(body)

	require.True(t, utf8.ValidString(got))
	require.Contains(t, got, "…")
}

// TestImportProjectsThinkingBlocks verifies that v7 captures Claude's
// extended-thinking blocks (`content[].type == "thinking"`) as
// dedicated KindThinking turns. Multiple thinking blocks in one
// assistant message become one turn each, preserving order, and
// over-long content is truncated by the same helper used for
// tool_result previews.
func TestImportProjectsThinkingBlocks(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	dir := t.TempDir()
	path := filepath.Join(dir, fixtureSessionID+".jsonl")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	bigThinking := strings.Repeat("z", importerutil.ToolPreviewMaxBytes+128)
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "user",
			"sessionId": fixtureSessionID,
			"timestamp": base.Format(time.RFC3339Nano),
			"cwd":       "/proj",
			"message":   map[string]any{"role": "user", "content": "do the thing"},
		},
		{
			"type":      "assistant",
			"sessionId": fixtureSessionID,
			"requestId": "req-1",
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"cwd":       "/proj",
			"message": map[string]any{
				"id":    "msg-1",
				"role":  "assistant",
				"model": "claude-sonnet-4-6",
				"usage": map[string]any{"input_tokens": 1, "output_tokens": 1},
				"content": []map[string]any{
					{"type": "thinking", "thinking": "first reasoning step"},
					{"type": "thinking", "thinking": bigThinking},
					{"type": "text", "text": "here is the answer"},
				},
			},
		},
	})

	sink := newSink()
	res, err := New().Import(ctx, path, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)

	turns := sink.Turns[fixtureSessionID]
	require.Len(t, turns, 4)
	require.Equal(t, session.KindMessage, turns[0].Kind)
	require.Equal(t, session.KindMessage, turns[1].Kind)
	require.Equal(t, "here is the answer", turns[1].Content)
	require.Equal(t, "assistant", turns[2].Role)
	require.Equal(t, session.KindThinking, turns[2].Kind)
	require.Equal(t, "first reasoning step", turns[2].Content)
	require.Equal(t, session.KindThinking, turns[3].Kind)
	require.LessOrEqual(t, len(turns[3].Content), importerutil.ToolPreviewMaxBytes+8,
		"oversized thinking is truncated by importerutil.TruncatePreview")
	require.Contains(t, turns[3].Content, "…",
		"importerutil.TruncatePreview leaves the ellipsis marker")
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

	res, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.Equal(t, fixtureSessionID, res.SessionID)
	require.Greater(t, res.RawSize, int64(8<<20))

	dstInfo, err := os.Stat(res.RawPath)
	require.NoError(t, err)
	require.Equal(t, info.Size(), dstInfo.Size())
}

// TestImportAdmitsSessionWithoutUsageEvent covers a transcript whose
// assistant messages never carry a `usage` field at all (older Claude
// Code captures, partial sessions). Under tri-state classification this
// is UsageStateUnknown and the importer admits it; sess.Usage stays nil
// and the panel renders the session without a cost row.
func TestImportAdmitsSessionWithoutUsageEvent(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	path := filepath.Join(t.TempDir(), fixtureSessionID+".jsonl")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "user",
			"sessionId": fixtureSessionID,
			"timestamp": base.Format(time.RFC3339Nano),
			"message":   map[string]any{"role": "user", "content": "hi"},
		},
		{
			"type":      "assistant",
			"sessionId": fixtureSessionID,
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"message": map[string]any{
				"role": "assistant", "model": "claude-sonnet-4-6",
				"content": []map[string]any{
					{"type": "text", "text": "hello"},
				},
			},
		},
	})

	sink := newSink()
	res, err := New().Import(ctx, path, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped,
		"transcripts without any usage event must admit (Unknown state)")
	require.Empty(t, res.SkipReason)
	require.Contains(t, sink.Sessions, fixtureSessionID)
	stored := sink.Sessions[fixtureSessionID]
	require.Nil(t, stored.Usage,
		"sess.Usage must be nil when no usage event was observed")
	require.NotEmpty(t, sink.Turns[fixtureSessionID])
}

// TestImportSkipsSessionWithExplicitZeroUsage covers a transcript whose
// assistant messages carry an explicit usage block whose totals are all
// zero. Under tri-state classification this is UsageStateExplicitZero
// and the importer skips with reason no_usage.
func TestImportSkipsSessionWithExplicitZeroUsage(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	path := filepath.Join(t.TempDir(), fixtureSessionID+".jsonl")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "user",
			"sessionId": fixtureSessionID,
			"timestamp": base.Format(time.RFC3339Nano),
			"message":   map[string]any{"role": "user", "content": "hi"},
		},
		{
			"type":      "assistant",
			"sessionId": fixtureSessionID,
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"message": map[string]any{
				"role": "assistant", "model": "claude-sonnet-4-6",
				"usage": map[string]any{
					"input_tokens":  0,
					"output_tokens": 0,
				},
				"content": []map[string]any{
					{"type": "text", "text": "hello"},
				},
			},
		},
	})

	sink := newSink()
	res, err := New().Import(ctx, path, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.True(t, res.Skipped)
	require.Equal(t, importer.SkipReasonNoUsage, res.SkipReason)
	require.Equal(t, res.RawHash, sink.Skips[fixtureSessionID][importer.SkipReasonNoUsage])
	require.Empty(t, sink.Sessions)
	require.Empty(t, sink.Turns)
	require.Empty(t, res.RawPath)

	res2, err := New().Import(ctx, path, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.True(t, res2.Skipped)
	require.Equal(t, importer.SkipReasonNoUsage, res2.SkipReason)
	require.Equal(t, res.RawHash, res2.RawHash)
	require.Equal(t, res.RawSize, res2.RawSize)
	require.Empty(t, sink.Sessions)
	require.Empty(t, sink.Turns)
	require.Empty(t, res2.RawPath)
}

func TestClaudeModelSkipsSyntheticPlaceholder(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	path := filepath.Join(t.TempDir(), fixtureSessionID+".jsonl")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "assistant",
			"sessionId": fixtureSessionID,
			"requestId": "synthetic",
			"timestamp": base.Format(time.RFC3339Nano),
			"message": map[string]any{
				"role":  "assistant",
				"model": "<synthetic>",
				"content": []map[string]any{
					{"type": "text", "text": "Please run /login"},
				},
			},
		},
		{
			"type":      "assistant",
			"sessionId": fixtureSessionID,
			"requestId": "real",
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"message": map[string]any{
				"role":  "assistant",
				"model": "claude-sonnet-4-6",
				"usage": map[string]any{
					"input_tokens":  10,
					"output_tokens": 2,
				},
				"content": []map[string]any{
					{"type": "text", "text": "ready"},
				},
			},
		},
	})

	sink := newSink()
	res, err := New().Import(ctx, path, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)

	s := sink.Sessions[fixtureSessionID]
	require.NotNil(t, s.Model)
	require.Equal(t, "claude-sonnet-4-6", *s.Model)
}

func TestWalkFiltersSubagentsAndNonUUID(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	proj := filepath.Join(root, "-Users-test-proj")
	require.NoError(t, os.MkdirAll(proj, 0o755))

	valid := filepath.Join(proj, fixtureSessionID+".jsonl")
	require.NoError(t, os.WriteFile(valid, []byte("{}\n"), 0o644))

	// Subagent JSONLs are picked up alongside the parent so the panel
	// can render the expansion — both the current `agent-<hex>.jsonl`
	// naming and the older `agent-<uuid>.jsonl`. A subagent file that
	// matches neither pattern (`agent-foo.jsonl`) is still ignored.
	subDir := filepath.Join(proj, fixtureSessionID, "subagents")
	require.NoError(t, os.MkdirAll(subDir, 0o755))
	subagentHex := filepath.Join(subDir, "agent-a189cf08bb8bed417.jsonl")
	require.NoError(t, os.WriteFile(subagentHex, []byte("{}\n"), 0o644))
	subagentUUID := filepath.Join(subDir, "agent-abcdef01-1234-4abc-9def-1234567890ab.jsonl")
	require.NoError(t, os.WriteFile(subagentUUID, []byte("{}\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(subDir, "agent-foo.jsonl"), []byte("{}\n"), 0o644))

	// Workflow-tool spawns nest one level deeper under subagents/.
	wfDir := filepath.Join(subDir, "workflows", "wf_3ae03bc2-d76")
	require.NoError(t, os.MkdirAll(wfDir, 0o755))
	subagentWorkflow := filepath.Join(wfDir, "agent-a00cb638405bb4c90.jsonl")
	require.NoError(t, os.WriteFile(subagentWorkflow, []byte("{}\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(wfDir, "agent-a00cb638405bb4c90.meta.json"), []byte("{}"), 0o644))

	memDir := filepath.Join(proj, "memory")
	require.NoError(t, os.MkdirAll(memDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(memDir, "notes.md"), []byte("x"), 0o644))

	require.NoError(t, os.WriteFile(filepath.Join(proj, "sessions-index.json"), []byte("{}"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(proj, "random.jsonl"), []byte("{}"), 0o644))

	imp := New()
	got, err := imp.Walk(context.Background(), root)
	require.NoError(t, err)
	require.ElementsMatch(t, []string{valid, subagentHex, subagentUUID, subagentWorkflow}, got)
}

// TestSubagentPathHelpers pins identity and parent-edge recovery for
// every observed subagent layout: Agent-tool spawns directly under
// `<parent>/subagents/`, Workflow-tool spawns nested under
// `subagents/workflows/wf_<id>/`, and degraded layouts where the
// directory above `subagents` is not UUID-shaped.
func TestSubagentPathHelpers(t *testing.T) {
	t.Parallel()
	parent := "5c91f397-d35c-4805-81ee-d0ee268909e3"
	cases := []struct {
		name   string
		path   string
		wantID string
		wantPa string
	}{
		{
			name:   "agent tool spawn",
			path:   "/r/-proj/" + parent + "/subagents/agent-a189cf08bb8bed417.jsonl",
			wantID: "agent-a189cf08bb8bed417",
			wantPa: parent,
		},
		{
			name:   "workflow tool spawn",
			path:   "/r/-proj/" + parent + "/subagents/workflows/wf_3ae03bc2-d76/agent-a00cb638405bb4c90.jsonl",
			wantID: "agent-a00cb638405bb4c90",
			wantPa: parent,
		},
		{
			name:   "old uuid naming",
			path:   "/r/-proj/" + parent + "/subagents/agent-abcdef01-1234-4abc-9def-1234567890ab.jsonl",
			wantID: "agent-abcdef01-1234-4abc-9def-1234567890ab",
			wantPa: parent,
		},
		{
			name:   "subagents dir without uuid parent keeps identity, no edge",
			path:   "/r/-proj/subagents/agent-a189cf08bb8bed417.jsonl",
			wantID: "agent-a189cf08bb8bed417",
			wantPa: "",
		},
		{
			name:   "non-matching basename",
			path:   "/r/-proj/" + parent + "/subagents/agent-foo.jsonl",
			wantID: "",
			wantPa: parent,
		},
		{
			name:   "top-level session",
			path:   "/r/-proj/" + parent + ".jsonl",
			wantID: "",
			wantPa: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.wantID, subagentSessionIDFromPath(tc.path))
			require.Equal(t, tc.wantPa, parentSessionIDFromPath(tc.path))
		})
	}
}

// TestImportSubagentSetsParentSessionID writes a parent JSONL plus a
// subagent JSONL under `<parent>/subagents/agent-<hex>.jsonl` in the
// real on-disk shape — every subagent record carries the PARENT's
// sessionId — and verifies the child is stored under the filename stem
// with ParentSessionID pointing at the directory above `subagents/`,
// without clobbering the parent's own row.
func TestImportSubagentSetsParentSessionID(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	dir := t.TempDir()
	proj := filepath.Join(dir, "-Users-test-proj")
	require.NoError(t, os.MkdirAll(proj, 0o755))

	parentJSONL := filepath.Join(proj, fixtureSessionID+".jsonl")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	writeJSONL(t, parentJSONL, []map[string]any{
		{
			"type":      "user",
			"sessionId": fixtureSessionID,
			"timestamp": base.Format(time.RFC3339Nano),
			"cwd":       "/proj",
			"message":   map[string]any{"role": "user", "content": "spawn an agent"},
		},
		{
			"type":      "assistant",
			"sessionId": fixtureSessionID,
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"message": map[string]any{
				"role": "assistant", "model": "claude-sonnet-4-6",
				"usage":   map[string]any{"input_tokens": 1, "output_tokens": 1},
				"content": []map[string]any{{"type": "text", "text": "ok"}},
			},
		},
	})

	// Real subagent shape: filename is `agent-<hex>`, every record's
	// sessionId is the PARENT's, and agentId/isSidechain mark the spawn.
	agentID := "a189cf08bb8bed417"
	subDir := filepath.Join(proj, fixtureSessionID, "subagents")
	require.NoError(t, os.MkdirAll(subDir, 0o755))
	subagentJSONL := filepath.Join(subDir, "agent-"+agentID+".jsonl")
	writeJSONL(t, subagentJSONL, []map[string]any{
		{
			"type":        "user",
			"sessionId":   fixtureSessionID,
			"agentId":     agentID,
			"isSidechain": true,
			"timestamp":   base.Add(2 * time.Second).Format(time.RFC3339Nano),
			"cwd":         "/proj",
			"message":     map[string]any{"role": "user", "content": "child task"},
		},
		{
			"type":        "assistant",
			"sessionId":   fixtureSessionID,
			"agentId":     agentID,
			"isSidechain": true,
			"timestamp":   base.Add(3 * time.Second).Format(time.RFC3339Nano),
			"message": map[string]any{
				"role": "assistant", "model": "claude-sonnet-4-6",
				"usage":   map[string]any{"input_tokens": 1, "output_tokens": 1},
				"content": []map[string]any{{"type": "text", "text": "child done"}},
			},
		},
	})

	sink := newSink()
	imp := New()
	parentRes, err := imp.Import(ctx, parentJSONL, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, parentRes.Skipped)
	childRes, err := imp.Import(ctx, subagentJSONL, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, childRes.Skipped)

	require.Equal(t, "agent-"+agentID, childRes.SessionID,
		"child id must come from the filename stem, not the embedded (parent) sessionId")

	parent := sink.Sessions[fixtureSessionID]
	require.Nil(t, parent.ParentSessionID, "top-level session has no parent")
	require.NotNil(t, parent.FirstPrompt)
	require.Equal(t, "spawn an agent", *parent.FirstPrompt,
		"importing the child must not clobber the parent row")

	child := sink.Sessions["agent-"+agentID]
	require.NotNil(t, child.ParentSessionID,
		"subagent session must carry the parent UUID from its path")
	require.Equal(t, fixtureSessionID, *child.ParentSessionID)
}

// TestImportSubagentWithoutUUIDParentDirKeepsOwnIdentity covers the
// degraded layout where a `subagents/` directory sits under a non-UUID
// directory: the child still takes its identity from the filename stem
// (never the embedded parent sessionId, which would clobber the parent
// row on upsert) and carries no parent edge.
func TestImportSubagentWithoutUUIDParentDirKeepsOwnIdentity(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	dir := t.TempDir()
	subDir := filepath.Join(dir, "-Users-test-proj", "subagents")
	require.NoError(t, os.MkdirAll(subDir, 0o755))

	agentID := "a189cf08bb8bed417"
	subagentJSONL := filepath.Join(subDir, "agent-"+agentID+".jsonl")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	writeJSONL(t, subagentJSONL, []map[string]any{
		{
			"type":        "user",
			"sessionId":   fixtureSessionID,
			"agentId":     agentID,
			"isSidechain": true,
			"timestamp":   base.Format(time.RFC3339Nano),
			"cwd":         "/proj",
			"message":     map[string]any{"role": "user", "content": "child task"},
		},
		{
			"type":      "assistant",
			"sessionId": fixtureSessionID,
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"message": map[string]any{
				"role": "assistant", "model": "claude-sonnet-4-6",
				"usage":   map[string]any{"input_tokens": 1, "output_tokens": 1},
				"content": []map[string]any{{"type": "text", "text": "done"}},
			},
		},
	})

	sink := newSink()
	res, err := New().Import(ctx, subagentJSONL, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.Equal(t, "agent-"+agentID, res.SessionID)

	child := sink.Sessions["agent-"+agentID]
	require.Nil(t, child.ParentSessionID,
		"no UUID-shaped parent directory means no edge")
	_, clobbered := sink.Sessions[fixtureSessionID]
	require.False(t, clobbered,
		"embedded sessionId must not become a session row")
}

func TestWalkMissingRootReturnsEmpty(t *testing.T) {
	t.Parallel()
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
		{
			"type":      "assistant",
			"sessionId": fixtureSessionID,
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"message": map[string]any{
				"role":  "assistant",
				"model": "claude-sonnet-4-6",
				"usage": map[string]any{
					"input_tokens":  10,
					"output_tokens": 2,
				},
				"content": []map[string]any{
					{"type": "text", "text": "ok"},
				},
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
	_, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	s := sink.Sessions[fixtureSessionID]
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "run the migration", *s.FirstPrompt)

	turns := sink.Turns[fixtureSessionID]
	require.NotEmpty(t, turns)
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, "run the migration", turns[0].Content)
}

// writeFixtureStdoutWrappedPrompt simulates a Claude Code session where
// the first user message is a slash-command echo: stdout wrapped in
// <local-command-stdout> with ANSI escapes inside, followed by the real
// human prompt. CleanPrompt should strip both.
func writeFixtureStdoutWrappedPrompt(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, fixtureSessionID+".jsonl")
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	dirtyText := "<local-command-stdout>Set model to \x1b[1mOpus 4.7 (1M context) (default)\x1b[22m " +
		"for this session with \x1b[1mmax\x1b[22m effort</local-command-stdout>\n\n" +
		"now refactor the sync logic"
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "user",
			"sessionId": fixtureSessionID,
			"timestamp": base.Format(time.RFC3339Nano),
			"cwd":       "/Users/test/proj",
			"message":   map[string]any{"role": "user", "content": dirtyText},
		},
		{
			"type":      "assistant",
			"sessionId": fixtureSessionID,
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"message": map[string]any{
				"role":  "assistant",
				"model": "claude-sonnet-4-6",
				"usage": map[string]any{
					"input_tokens":  10,
					"output_tokens": 2,
				},
				"content": []map[string]any{
					{"type": "text", "text": "ok"},
				},
			},
		},
	})
	return path
}

func TestImportStripsStdoutWrapperAndANSI(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	src := writeFixtureStdoutWrappedPrompt(t, t.TempDir())

	sink := newSink()
	imp := New()
	_, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	s := sink.Sessions[fixtureSessionID]
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "now refactor the sync logic", *s.FirstPrompt)

	turns := sink.Turns[fixtureSessionID]
	require.NotEmpty(t, turns)
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, "now refactor the sync logic", turns[0].Content)
}
