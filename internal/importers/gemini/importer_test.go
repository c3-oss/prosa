package gemini

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/importers/importertest"
	"github.com/c3-oss/prosa/pkg/importer"
)

const (
	fixtureEnvelopeID = "2dfdf4cf-1ea8-4bea-a5ac-e35b3c0ae0bc"
	fixtureLiveID     = "42ce6531-ac76-44b8-be24-c44044f324fa"
)

func newSink() *importertest.Sink {
	return importertest.NewSink()
}

// writeEnvelopeFixture lays out a chats/session-*.json under root using
// the legacy bundle shape.
func writeEnvelopeFixture(t *testing.T, root string) string {
	t.Helper()
	dir := filepath.Join(root, "projhash-abc", "chats")
	require.NoError(t, os.MkdirAll(dir, 0o755))

	envelope := map[string]any{
		"sessionId":   fixtureEnvelopeID,
		"projectHash": "projhash-abc",
		"startTime":   "2026-01-22T15:41:22.874Z",
		"lastUpdated": "2026-01-22T16:16:40.992Z",
		"messages": []map[string]any{
			{
				"id":        "u1",
				"timestamp": "2026-01-22T15:41:22.874Z",
				"type":      "user",
				"content":   "Revise this PR for me",
			},
			{
				"id":        "g1",
				"timestamp": "2026-01-22T15:42:03.345Z",
				"type":      "gemini",
				"model":     "gemini-2.5-pro",
				"content":   "I will start by fetching the diff",
				"tokens": map[string]any{
					"input":    100,
					"cached":   30,
					"output":   20,
					"thoughts": 10,
					"tool":     5,
					"total":    135,
				},
				"toolCalls": []map[string]any{
					{"name": "list_directory"},
					{"name": "list_directory"},
					{"name": "read_file"},
				},
			},
			{
				"id":        "info1",
				"timestamp": "2026-01-22T15:42:10.000Z",
				"type":      "info",
				"content":   "Operational note — ignored",
			},
		},
	}
	path := filepath.Join(dir, "session-2026-01-22T15-40-2dfdf4cf.json")
	data, err := json.MarshalIndent(envelope, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(path, data, 0o644))
	return path
}

// writeLiveFixture lays out a logs.json under root using the new live shape.
func writeLiveFixture(t *testing.T, root string) string {
	t.Helper()
	dir := filepath.Join(root, "projhash-live")
	require.NoError(t, os.MkdirAll(dir, 0o755))

	rows := []map[string]any{
		{
			"sessionId": fixtureLiveID, "messageId": 0,
			"type": "user", "message": "Read the README",
			"timestamp": "2025-08-21T04:34:21.812Z",
		},
		{
			"sessionId": fixtureLiveID, "messageId": 1,
			"type": "user", "message": "Update CLAUDE.md",
			"timestamp": "2025-08-21T04:34:52.870Z",
		},
		// Stray record for a different session id — must be excluded
		// because fixtureLiveID has more messages.
		{
			"sessionId": "00000000-0000-0000-0000-000000000000", "messageId": 0,
			"type": "user", "message": "Other session prompt",
			"timestamp": "2025-08-21T04:30:00.000Z",
		},
	}
	path := filepath.Join(dir, "logs.json")
	data, err := json.MarshalIndent(rows, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(path, data, 0o644))
	return path
}

func TestImportEnvelope(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "gemini-root")
	src := writeEnvelopeFixture(t, root)
	sink := newSink()
	imp := New()

	res, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.Equal(t, fixtureEnvelopeID, res.SessionID)
	require.FileExists(t, res.RawPath)

	s := sink.Sessions[fixtureEnvelopeID]
	require.Equal(t, Name, s.Agent)
	require.NotEmpty(t, s.DeviceID)
	require.NotEqual(t, "local", s.DeviceID)
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "Revise this PR for me", *s.FirstPrompt)
	require.NotNil(t, s.Model)
	require.Equal(t, "gemini-2.5-pro", *s.Model)
	require.NotNil(t, s.Usage)
	require.Equal(t, int64(135), s.Usage.TotalTokens)
	require.Equal(t, int64(100), s.Usage.InputTokens)
	require.Equal(t, int64(20), s.Usage.OutputTokens)
	require.Equal(t, int64(30), s.Usage.CachedTokens)
	require.Equal(t, 2026, s.StartedAt.Year())

	turns := sink.Turns[fixtureEnvelopeID]
	require.Len(t, turns, 2) // user + gemini; info is skipped.
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, "assistant", turns[1].Role)

	tools := sink.Tools[fixtureEnvelopeID]
	require.Len(t, tools, 2)
	byName := map[string]int{}
	for _, tl := range tools {
		byName[tl.Name] = tl.Count
	}
	require.Equal(t, 2, byName["list_directory"])
	require.Equal(t, 1, byName["read_file"])

	res2, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.True(t, res2.Skipped)
}

func TestParseLiveLogs(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	root := filepath.Join(t.TempDir(), "gemini-root")
	src := writeLiveFixture(t, root)

	s, turns, tools, _, err := parseSession(ctx, src)
	require.NoError(t, err)

	require.Equal(t, fixtureLiveID, s.ID)
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "Read the README", *s.FirstPrompt)
	require.Equal(t, 2025, s.StartedAt.Year())
	require.Equal(t, time.August, s.StartedAt.Month())

	require.Len(t, turns, 2)
	require.Equal(t, "Update CLAUDE.md", turns[1].Content)
	require.Empty(t, tools)
}

// TestImportLiveLogsAdmitsWithoutUsage covers a gemini logs.json whose
// records never carry a `tokens` block (older gemini live captures or
// pure-user sessions). Under tri-state classification this is
// UsageStateUnknown and the importer admits the session.
func TestImportLiveLogsAdmitsWithoutUsage(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "gemini-root")
	src := writeLiveFixture(t, root)
	sink := newSink()

	res, err := New().Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped,
		"gemini logs without any tokens block must admit (Unknown state)")
	require.Empty(t, res.SkipReason)
	require.Equal(t, fixtureLiveID, res.SessionID)
	require.Contains(t, sink.Sessions, fixtureLiveID)
	stored := sink.Sessions[fixtureLiveID]
	require.Nil(t, stored.Usage,
		"sess.Usage must be nil when no gemini message carried a tokens block")
}

// TestImportLiveLogsSkipsWithExplicitZeroUsage covers the explicit-zero
// case: a gemini reply emits a `tokens` block whose totals are all zero.
func TestImportLiveLogsSkipsWithExplicitZeroUsage(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "gemini-root")
	dir := filepath.Join(root, "projhash-zero")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	const zeroSessionID = "8a8a8a8a-1111-2222-3333-444444444444"
	rows := []map[string]any{
		{
			"sessionId": zeroSessionID, "messageId": 0,
			"type": "user", "message": "hi",
			"timestamp": "2026-05-30T12:00:00.000Z",
		},
		{
			"sessionId": zeroSessionID, "messageId": 1,
			"type": "gemini", "message": "hello",
			"timestamp": "2026-05-30T12:00:01.000Z",
			"tokens":    map[string]any{"input": int64(0), "output": int64(0), "total": int64(0)},
		},
	}
	path := filepath.Join(dir, "logs.json")
	data, err := json.MarshalIndent(rows, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(path, data, 0o644))

	sink := newSink()
	res, err := New().Import(ctx, path, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.True(t, res.Skipped,
		"gemini logs with explicit-zero tokens must skip")
	require.Equal(t, importer.SkipReasonNoUsage, res.SkipReason)
	require.Equal(t, res.RawHash, sink.Skips[zeroSessionID][importer.SkipReasonNoUsage])
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

func TestWalkFindsBothShapes(t *testing.T) {
	t.Parallel()
	root := filepath.Join(t.TempDir(), "gemini-root")
	envSrc := writeEnvelopeFixture(t, root)
	liveSrc := writeLiveFixture(t, root)
	// Decoy: not session-*.json and not logs.json — ignored.
	require.NoError(t, os.WriteFile(filepath.Join(root, "garbage.json"), []byte("{}"), 0o644))

	imp := New()
	got, err := imp.Walk(context.Background(), root)
	require.NoError(t, err)
	require.ElementsMatch(t, []string{envSrc, liveSrc}, got)
}

func TestWalkSkipsEmptyLiveLogs(t *testing.T) {
	t.Parallel()
	root := filepath.Join(t.TempDir(), "gemini-root")
	emptyDir := filepath.Join(root, "empty")
	require.NoError(t, os.MkdirAll(emptyDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(emptyDir, "logs.json"), []byte("[]"), 0o644))
	liveSrc := writeLiveFixture(t, root)

	imp := New()
	got, err := imp.Walk(context.Background(), root)
	require.NoError(t, err)
	require.Equal(t, []string{liveSrc}, got)
}

func TestWalkMissingRootReturnsEmpty(t *testing.T) {
	t.Parallel()
	imp := New()
	got, err := imp.Walk(context.Background(), filepath.Join(t.TempDir(), "nope"))
	require.NoError(t, err)
	require.Empty(t, got)
}

// TestImportEnvelopeSanitizesFirstPrompt ensures gemini's envelope shape
// runs the same prompt cleanup as claudecode/codex now: ANSI escapes and
// <local-command-stdout> wrappers are stripped before the prompt lands
// in FirstPrompt.
func TestImportEnvelopeSanitizesFirstPrompt(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "gemini-root-dirty")
	const dirtyID = "55aa66bb-1111-2222-3333-444455556666"
	dir := filepath.Join(root, "projhash-dirty", "chats")
	require.NoError(t, os.MkdirAll(dir, 0o755))

	dirtyText := "<local-command-stdout>Set model to \x1b[1mflash\x1b[22m</local-command-stdout>\n" +
		"now refactor sync"
	envelope := map[string]any{
		"sessionId":   dirtyID,
		"projectHash": "projhash-dirty",
		"startTime":   "2026-03-01T10:00:00.000Z",
		"lastUpdated": "2026-03-01T10:05:00.000Z",
		"messages": []map[string]any{
			{"id": "u1", "timestamp": "2026-03-01T10:00:00.000Z", "type": "user", "content": dirtyText},
			{
				"id": "g1", "timestamp": "2026-03-01T10:00:10.000Z",
				"type": "gemini", "model": "gemini-2.5-pro", "content": "ok",
				"tokens": map[string]any{"input": int64(10), "output": int64(2), "total": int64(12)},
			},
		},
	}
	path := filepath.Join(dir, "session-2026-03-01T10-00-55aa66bb.json")
	data, err := json.MarshalIndent(envelope, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(path, data, 0o644))

	sink := newSink()
	res, err := New().Import(ctx, path, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)
	s := sink.Sessions[dirtyID]
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "now refactor sync", *s.FirstPrompt)
}
