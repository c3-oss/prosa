package grokbuild

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/importers/importertest"
	"github.com/c3-oss/prosa/pkg/importer"
	"github.com/c3-oss/prosa/pkg/session"
)

const (
	uuidA = "019fcac4-5030-7a21-8d42-f69b20a9b96e"
	uuidB = "019fa9aa-9755-7681-b78b-5b3ed433ba46"
	uuidC = "019fa9ab-3ad1-7a93-b7a7-2c9d0e038a25"

	encodedCwd = "%2Ftmp%2Fgrok%20project"
	decodedCwd = "/tmp/grok project"
)

func newSink() *importertest.Sink { return importertest.NewSink() }

func defaultSummary(id string) map[string]any {
	return map[string]any{
		"info":             map[string]any{"id": id, "cwd": decodedCwd},
		"created_at":       "2026-08-04T03:14:51.191165Z",
		"updated_at":       "2026-08-04T03:23:49.698552Z",
		"last_active_at":   "2026-08-04T03:23:49.698552Z",
		"current_model_id": "grok-4.5",
		"generated_title":  "Test Session",
		"git_remotes":      []string{"git@github.com:example/repo.git"},
	}
}

func humanUser(promptIndex int, text string) map[string]any {
	return map[string]any{
		"type":         "user",
		"content":      []map[string]any{{"type": "text", "text": "<user_query>\n" + text + "\n</user_query>"}},
		"prompt_index": promptIndex,
	}
}

func syntheticUser(reason, text string) map[string]any {
	return map[string]any{
		"type":             "user",
		"content":          []map[string]any{{"type": "text", "text": text}},
		"synthetic_reason": reason,
	}
}

func injectedUser(text string) map[string]any {
	return map[string]any{
		"type":    "user",
		"content": []map[string]any{{"type": "text", "text": text}},
	}
}

func assistant(content string, calls ...map[string]any) map[string]any {
	rec := map[string]any{
		"type":     "assistant",
		"content":  content,
		"model_id": "grok-4.5-build",
	}
	if len(calls) > 0 {
		rec["tool_calls"] = calls
	}
	return rec
}

func toolCallRec(id, name, args string) map[string]any {
	return map[string]any{"id": id, "name": name, "arguments": args}
}

func toolResult(callID, content string) map[string]any {
	return map[string]any{"type": "tool_result", "tool_call_id": callID, "content": content}
}

func reasoningRec(summaries ...string) map[string]any {
	blocks := make([]map[string]any, 0, len(summaries))
	for _, s := range summaries {
		blocks = append(blocks, map[string]any{"type": "summary_text", "text": s})
	}
	return map[string]any{"type": "reasoning", "summary": blocks, "encrypted_content": "opaque"}
}

func turnCompleted(sessionID, promptID string, usage map[string]any) map[string]any {
	return map[string]any{
		"timestamp": 1785813411,
		"method":    "_x.ai/session/update",
		"params": map[string]any{
			"sessionId": sessionID,
			"update": map[string]any{
				"sessionUpdate": "turn_completed",
				"prompt_id":     promptID,
				"usage":         usage,
			},
		},
	}
}

func usageDelta(input, output, cachedRead, cacheCreation int64) map[string]any {
	return map[string]any{
		"inputTokens":         input,
		"outputTokens":        output,
		"totalTokens":         input + output,
		"cachedReadTokens":    cachedRead,
		"cacheCreationTokens": cacheCreation,
		"reasoningTokens":     10,
		"costUsdTicks":        1046716000,
	}
}

func marshalLines(t *testing.T, records []map[string]any) []byte {
	t.Helper()
	var buf bytes.Buffer
	for _, r := range records {
		b, err := json.Marshal(r)
		require.NoError(t, err)
		buf.Write(b)
		buf.WriteByte('\n')
	}
	return buf.Bytes()
}

// writeSessionDir lays out one session directory under
// <root>/<encodedCwd>/<id>/ and returns the summary.json anchor path.
// nil chat / updates omit the corresponding file.
func writeSessionDir(t *testing.T, root, project, id string, summary map[string]any, chat, updates []map[string]any) string {
	t.Helper()
	dir := filepath.Join(root, project, id)
	require.NoError(t, os.MkdirAll(dir, 0o755))

	b, err := json.MarshalIndent(summary, "", "  ")
	require.NoError(t, err)
	summaryPath := filepath.Join(dir, "summary.json")
	require.NoError(t, os.WriteFile(summaryPath, b, 0o644))

	if chat != nil {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "chat_history.jsonl"), marshalLines(t, chat), 0o644))
	}
	if updates != nil {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "updates.jsonl"), marshalLines(t, updates), 0o644))
	}
	return summaryPath
}

func importSession(t *testing.T, summaryPath string, sink *importertest.Sink, opts importer.ImportOptions) importer.ImportResult {
	t.Helper()
	res, err := New().Import(context.Background(), summaryPath, sink, opts)
	require.NoError(t, err)
	return res
}

func TestWalkFindsSessionSummaries(t *testing.T) {
	root := t.TempDir()

	pathA := writeSessionDir(t, root, encodedCwd, uuidA, defaultSummary(uuidA), nil, nil)
	pathB := writeSessionDir(t, root, "%2Fother", uuidB, defaultSummary(uuidB), nil, nil)

	// Decoys: search index at the root, project-level prompt history,
	// non-uuid dirs, a uuid dir without summary.json, and a nested
	// subagents summary at the wrong depth.
	require.NoError(t, os.WriteFile(filepath.Join(root, "session_search.sqlite"), []byte("db"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, encodedCwd, "prompt_history.jsonl"), []byte("{}\n"), 0o644))
	require.NoError(t, os.MkdirAll(filepath.Join(root, encodedCwd, "terminal"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(root, encodedCwd, uuidC), 0o755)) // no summary.json
	nested := filepath.Join(root, encodedCwd, uuidA, "subagents", uuidC)
	require.NoError(t, os.MkdirAll(nested, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(nested, "summary.json"), []byte("{}"), 0o644))

	got, err := New().Walk(context.Background(), root)
	require.NoError(t, err)
	require.ElementsMatch(t, []string{pathA, pathB}, got)
}

func TestWalkMissingRootReturnsEmpty(t *testing.T) {
	got, err := New().Walk(context.Background(), filepath.Join(t.TempDir(), "does-not-exist"))
	require.NoError(t, err)
	require.Empty(t, got)
}

func TestImportBasicSession(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	chat := []map[string]any{
		{"type": "system", "content": "You are Grok."},
		syntheticUser("project_instructions", "injected instructions"),
		humanUser(0, "fix the flaky test"),
		assistant("Looking at the test now.", toolCallRec("call-1", "read_file", `{"target_file":"a.go"}`)),
		reasoningRec("The test races on a channel."),
		toolResult("call-1", "package main"),
	}
	updates := []map[string]any{
		turnCompleted(uuidA, "prompt-1", usageDelta(1000, 200, 800, 50)),
	}
	summaryPath := writeSessionDir(t, root, encodedCwd, uuidA, defaultSummary(uuidA), chat, updates)

	sink := newSink()
	res := importSession(t, summaryPath, sink, importer.ImportOptions{})
	require.False(t, res.Skipped)
	require.Equal(t, uuidA, res.SessionID)

	sess, ok := sink.Sessions[uuidA]
	require.True(t, ok)
	require.Equal(t, Name, sess.Agent)
	require.Equal(t, session.DefaultProfile, sess.Profile)
	require.NotNil(t, sess.ProjectPath)
	require.Equal(t, decodedCwd, *sess.ProjectPath)
	require.NotNil(t, sess.Model)
	require.Equal(t, "grok-4.5", *sess.Model)
	require.Equal(t, "2026-08-04T03:14:51.191165Z", sess.StartedAt.Format("2006-01-02T15:04:05.999999Z07:00"))
	require.True(t, sess.LastActivityAt.After(sess.StartedAt))
	require.NotNil(t, sess.FirstPrompt)
	require.Equal(t, "fix the flaky test", *sess.FirstPrompt)
	require.NotNil(t, sess.Usage)
	require.Equal(t, int64(1000), sess.Usage.InputTokens)
	require.Equal(t, int64(200), sess.Usage.OutputTokens)
	require.Equal(t, int64(1200), sess.Usage.TotalTokens)
	require.Equal(t, int64(800), sess.Usage.CacheReadTokens)
	require.Equal(t, int64(50), sess.Usage.CacheCreationTokens)

	turns := sink.Turns[uuidA]
	require.Len(t, turns, 4)
	require.Equal(t, session.KindMessage, turns[0].Kind)
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, "fix the flaky test", turns[0].Content)
	require.Equal(t, session.KindMessage, turns[1].Kind)
	require.Equal(t, "assistant", turns[1].Role)
	require.Equal(t, session.KindThinking, turns[2].Kind)
	require.Equal(t, session.KindToolResult, turns[3].Kind)
	require.Equal(t, "read_file", turns[3].ToolName)

	require.Equal(t, []session.ToolUsage{{Name: "read_file", Count: 1}}, sink.Tools[uuidA])

	require.FileExists(t, sess.RawPath)
	require.Equal(t, res.RawHash, sess.RawHash)
	require.Equal(t, res.RawHash, sink.Hashes[uuidA])
}

func TestImportSkipsSyntheticAndInjectedUserLines(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	chat := []map[string]any{
		syntheticUser("system_reminder", "a reminder"),
		injectedUser("injected context without prompt_index"),
		humanUser(0, "the actual request"),
	}
	summaryPath := writeSessionDir(t, root, encodedCwd, uuidA, defaultSummary(uuidA), chat, []map[string]any{
		turnCompleted(uuidA, "p", usageDelta(10, 5, 0, 0)),
	})

	sink := newSink()
	importSession(t, summaryPath, sink, importer.ImportOptions{})

	turns := sink.Turns[uuidA]
	require.Len(t, turns, 1)
	require.Equal(t, "the actual request", turns[0].Content)
	require.Equal(t, "the actual request", *sink.Sessions[uuidA].FirstPrompt)
}

func TestImportSumsTurnCompletedUsage(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	updates := []map[string]any{
		{"method": "_x.ai/session/update", "params": map[string]any{
			"update": map[string]any{"sessionUpdate": "agent_message_delta"},
		}},
		turnCompleted(uuidA, "p1", usageDelta(100, 20, 60, 0)),
		turnCompleted(uuidA, "p2", usageDelta(300, 40, 200, 5)),
	}
	summaryPath := writeSessionDir(t, root, encodedCwd, uuidA, defaultSummary(uuidA),
		[]map[string]any{humanUser(0, "hi")}, updates)

	sink := newSink()
	importSession(t, summaryPath, sink, importer.ImportOptions{})

	u := sink.Sessions[uuidA].Usage
	require.NotNil(t, u)
	require.Equal(t, int64(400), u.InputTokens)
	require.Equal(t, int64(60), u.OutputTokens)
	require.Equal(t, int64(460), u.TotalTokens)
	require.Equal(t, int64(260), u.CacheReadTokens)
	require.Equal(t, int64(260), u.CachedTokens)
	require.Equal(t, int64(5), u.CacheCreationTokens)
}

func TestImportExcludesSubagentCompletedUsage(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	updates := []map[string]any{
		turnCompleted(uuidA, "p1", usageDelta(100, 20, 0, 0)),
		turnCompleted(uuidA, "subagent-completed-"+uuidC, usageDelta(9999, 999, 0, 0)),
	}
	summaryPath := writeSessionDir(t, root, encodedCwd, uuidA, defaultSummary(uuidA),
		[]map[string]any{humanUser(0, "hi")}, updates)

	sink := newSink()
	importSession(t, summaryPath, sink, importer.ImportOptions{})

	u := sink.Sessions[uuidA].Usage
	require.NotNil(t, u)
	require.Equal(t, int64(100), u.InputTokens)
	require.Equal(t, int64(20), u.OutputTokens)

	// A session whose ONLY ledger record is a subagent aggregate has no
	// usage signal of its own: Unknown, admitted with nil usage — not
	// ExplicitZero.
	onlyAggregate := writeSessionDir(t, root, encodedCwd, uuidB, defaultSummary(uuidB),
		[]map[string]any{humanUser(0, "delegate")},
		[]map[string]any{turnCompleted(uuidB, "subagent-completed-"+uuidC, usageDelta(50, 5, 0, 0))})

	res := importSession(t, onlyAggregate, sink, importer.ImportOptions{})
	require.False(t, res.Skipped)
	require.Nil(t, sink.Sessions[uuidB].Usage)
}

func TestImportAdmitsSessionWithoutUpdates(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	summaryPath := writeSessionDir(t, root, encodedCwd, uuidA, defaultSummary(uuidA),
		[]map[string]any{humanUser(0, "hi")}, nil)

	sink := newSink()
	res := importSession(t, summaryPath, sink, importer.ImportOptions{})
	require.False(t, res.Skipped)

	sess, ok := sink.Sessions[uuidA]
	require.True(t, ok)
	require.Nil(t, sess.Usage)
}

func TestImportSkipsSessionWithExplicitZeroUsage(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	summaryPath := writeSessionDir(t, root, encodedCwd, uuidA, defaultSummary(uuidA),
		[]map[string]any{humanUser(0, "hi")},
		[]map[string]any{turnCompleted(uuidA, "p1", usageDelta(0, 0, 0, 0))})

	sink := newSink()
	res := importSession(t, summaryPath, sink, importer.ImportOptions{})
	require.True(t, res.Skipped)
	require.Equal(t, importer.SkipReasonNoUsage, res.SkipReason)
	require.Empty(t, sink.Sessions)

	// The skip is remembered: a second pass short-circuits on the
	// recorded hash before parsing.
	again := importSession(t, summaryPath, sink, importer.ImportOptions{})
	require.True(t, again.Skipped)
	require.Equal(t, importer.SkipReasonNoUsage, again.SkipReason)
}

func TestImportSetsParentSessionIDFromSiblingMeta(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	childSummary := defaultSummary(uuidC)
	childSummary["session_kind"] = "subagent"
	childPath := writeSessionDir(t, root, encodedCwd, uuidC, childSummary,
		[]map[string]any{humanUser(0, "run the boot lanes")},
		[]map[string]any{turnCompleted(uuidC, "p1", usageDelta(10, 5, 0, 0))})

	sink := newSink()
	first := importSession(t, childPath, sink, importer.ImportOptions{})
	require.False(t, first.Skipped)
	require.Nil(t, sink.Sessions[uuidC].ParentSessionID)

	// The parent's meta.json appears later (parent session dir is a
	// sibling under the same project dir). Its content enters the
	// projection, so the hash changes and a plain re-import picks up
	// the edge.
	metaDir := filepath.Join(root, encodedCwd, uuidB, "subagents", uuidC)
	require.NoError(t, os.MkdirAll(metaDir, 0o755))
	meta, err := json.Marshal(map[string]any{
		"subagent_id":       uuidC,
		"parent_session_id": uuidB,
		"child_session_id":  uuidC,
	})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(metaDir, "meta.json"), meta, 0o644))

	second := importSession(t, childPath, sink, importer.ImportOptions{})
	require.False(t, second.Skipped)
	require.NotEqual(t, first.RawHash, second.RawHash)
	require.NotNil(t, sink.Sessions[uuidC].ParentSessionID)
	require.Equal(t, uuidB, *sink.Sessions[uuidC].ParentSessionID)

	raw, err := os.ReadFile(sink.Sessions[uuidC].RawPath)
	require.NoError(t, err)
	require.Contains(t, string(raw), `"type":"subagent_meta"`)
	require.Contains(t, string(raw), `"parent_session_id":"`+uuidB+`"`)
}

func TestImportIdempotentSkipThenReimportOnNewUsage(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	updates := []map[string]any{turnCompleted(uuidA, "p1", usageDelta(100, 20, 0, 0))}
	summaryPath := writeSessionDir(t, root, encodedCwd, uuidA, defaultSummary(uuidA),
		[]map[string]any{humanUser(0, "hi")}, updates)

	sink := newSink()
	first := importSession(t, summaryPath, sink, importer.ImportOptions{})
	require.False(t, first.Skipped)

	second := importSession(t, summaryPath, sink, importer.ImportOptions{})
	require.True(t, second.Skipped)
	require.Equal(t, first.RawHash, second.RawHash)

	// A new turn lands in updates.jsonl → hash changes → re-import.
	newLine := marshalLines(t, []map[string]any{turnCompleted(uuidA, "p2", usageDelta(50, 10, 0, 0))})
	f, err := os.OpenFile(filepath.Join(filepath.Dir(summaryPath), "updates.jsonl"), os.O_APPEND|os.O_WRONLY, 0o644)
	require.NoError(t, err)
	_, err = f.Write(newLine)
	require.NoError(t, err)
	require.NoError(t, f.Close())

	third := importSession(t, summaryPath, sink, importer.ImportOptions{})
	require.False(t, third.Skipped)
	require.NotEqual(t, first.RawHash, third.RawHash)
	require.Equal(t, int64(150), sink.Sessions[uuidA].Usage.InputTokens)
}

func TestImportProjectsRawWithUsageProvenance(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	summaryPath := writeSessionDir(t, root, encodedCwd, uuidA, defaultSummary(uuidA),
		[]map[string]any{humanUser(0, "hi")},
		[]map[string]any{
			{"method": "_x.ai/session/update", "params": map[string]any{
				"update": map[string]any{"sessionUpdate": "agent_message_delta"},
			}},
			turnCompleted(uuidA, "p1", usageDelta(100, 20, 60, 0)),
		})

	sink := newSink()
	res := importSession(t, summaryPath, sink, importer.ImportOptions{})

	raw, err := os.ReadFile(sink.Sessions[uuidA].RawPath)
	require.NoError(t, err)

	// Pre-write hash/size (dedup key) describe exactly the preserved bytes.
	sum := sha256.Sum256(raw)
	require.Equal(t, hex.EncodeToString(sum[:]), res.RawHash)
	require.Equal(t, int64(len(raw)), res.RawSize)
	require.Equal(t, res.RawHash, sink.Hashes[uuidA])

	lines := strings.Split(string(raw), "\n")
	require.True(t, strings.HasPrefix(lines[0], `{"type":"session_summary","data":`))
	require.Contains(t, string(raw), `"sessionUpdate":"turn_completed"`)
	require.Contains(t, string(raw), `"costUsdTicks"`)
	require.NotContains(t, string(raw), "agent_message_delta")
}

func TestImportProjectsReasoningSummaryAndToolResults(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	chat := []map[string]any{
		humanUser(0, "explain"),
		reasoningRec(), // empty summary → no turn
		assistant("", toolCallRec("call-9", "run_terminal_command", `{"command":"ls"}`)),
		reasoningRec("First I list files.", "Then I read them."),
		toolResult("call-9", "file-a\nfile-b"),
	}
	summaryPath := writeSessionDir(t, root, encodedCwd, uuidA, defaultSummary(uuidA), chat,
		[]map[string]any{turnCompleted(uuidA, "p", usageDelta(10, 5, 0, 0))})

	sink := newSink()
	importSession(t, summaryPath, sink, importer.ImportOptions{})

	turns := sink.Turns[uuidA]
	require.Len(t, turns, 3)
	require.Equal(t, session.KindThinking, turns[1].Kind)
	require.Equal(t, "First I list files.\nThen I read them.", turns[1].Content)
	require.Equal(t, session.KindToolResult, turns[2].Kind)
	require.Equal(t, "run_terminal_command", turns[2].ToolName)
	require.Equal(t, "file-a\nfile-b", turns[2].Content)
}

func TestImportCountsToolCallsOnEmptyContentAssistant(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	chat := []map[string]any{
		humanUser(0, "do things"),
		assistant("",
			toolCallRec("call-1", "read_file", `{"target_file":"a.go"}`),
			toolCallRec("call-2", "read_file", `{"target_file":"b.go"}`),
			toolCallRec("call-3", "run_terminal_command", `{"command":"go test"}`)),
		toolResult("call-3", "ok"),
	}
	summaryPath := writeSessionDir(t, root, encodedCwd, uuidA, defaultSummary(uuidA), chat,
		[]map[string]any{turnCompleted(uuidA, "p", usageDelta(10, 5, 0, 0))})

	sink := newSink()
	importSession(t, summaryPath, sink, importer.ImportOptions{})

	counts := map[string]int{}
	for _, tu := range sink.Tools[uuidA] {
		counts[tu.Name] = tu.Count
	}
	require.Equal(t, map[string]int{"read_file": 2, "run_terminal_command": 1}, counts)

	turns := sink.Turns[uuidA]
	require.Len(t, turns, 2) // user + tool_result; no empty assistant message turn
	require.Equal(t, session.KindToolResult, turns[1].Kind)
	require.Equal(t, "run_terminal_command", turns[1].ToolName)
}

func TestImportCountsBackendToolCalls(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	chat := []map[string]any{
		humanUser(0, "search the web"),
		{"type": "backend_tool_call", "kind": map[string]any{
			"tool_type": "web_search",
			"action":    map[string]any{"type": "search", "query": "grok build"},
		}},
	}
	summaryPath := writeSessionDir(t, root, encodedCwd, uuidA, defaultSummary(uuidA), chat,
		[]map[string]any{turnCompleted(uuidA, "p", usageDelta(10, 5, 0, 0))})

	sink := newSink()
	importSession(t, summaryPath, sink, importer.ImportOptions{})

	require.Equal(t, []session.ToolUsage{{Name: "web_search", Count: 1}}, sink.Tools[uuidA])
	require.Len(t, sink.Turns[uuidA], 1) // backend calls yield no turn
}

func TestImportErrorsOnMalformedSummary(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	dir := filepath.Join(root, encodedCwd, uuidA)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	summaryPath := filepath.Join(dir, "summary.json")
	require.NoError(t, os.WriteFile(summaryPath, []byte("{not json"), 0o644))

	_, err := New().Import(context.Background(), summaryPath, newSink(), importer.ImportOptions{})
	require.Error(t, err)
}

func TestImportDropsMalformedAndTornLines(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	summaryPath := writeSessionDir(t, root, encodedCwd, uuidA, defaultSummary(uuidA), nil,
		[]map[string]any{turnCompleted(uuidA, "p", usageDelta(10, 5, 0, 0))})

	valid := marshalLines(t, []map[string]any{humanUser(0, "still works")})
	chat := append([]byte("{broken json}\n"), valid...)
	chat = append(chat, []byte(`{"type":"assistant","content":"torn lin`)...) // torn tail, no newline
	require.NoError(t, os.WriteFile(filepath.Join(filepath.Dir(summaryPath), "chat_history.jsonl"), chat, 0o644))

	sink := newSink()
	res := importSession(t, summaryPath, sink, importer.ImportOptions{})
	require.False(t, res.Skipped)

	turns := sink.Turns[uuidA]
	require.Len(t, turns, 1)
	require.Equal(t, "still works", turns[0].Content)

	raw, err := os.ReadFile(sink.Sessions[uuidA].RawPath)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "broken json")
	require.NotContains(t, string(raw), "torn lin")
}

func TestImportPrefersSummaryIDOverDirName(t *testing.T) {
	t.Setenv("PROSA_HOME", t.TempDir())
	root := t.TempDir()

	summary := defaultSummary(uuidB) // info.id differs from the dir name below
	summaryPath := writeSessionDir(t, root, encodedCwd, uuidA, summary,
		[]map[string]any{humanUser(0, "hi")},
		[]map[string]any{turnCompleted(uuidB, "p", usageDelta(10, 5, 0, 0))})

	sink := newSink()
	res := importSession(t, summaryPath, sink, importer.ImportOptions{})
	require.Equal(t, uuidB, res.SessionID)
	_, ok := sink.Sessions[uuidB]
	require.True(t, ok)
	_, wrongID := sink.Sessions[uuidA]
	require.False(t, wrongID)

	// Idempotency holds on the summary id: a second pass skips.
	again := importSession(t, summaryPath, sink, importer.ImportOptions{})
	require.True(t, again.Skipped)
	require.Equal(t, uuidB, again.SessionID)
}
