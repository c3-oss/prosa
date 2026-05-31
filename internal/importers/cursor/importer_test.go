package cursor

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/importer"
	"github.com/c3-oss/prosa/pkg/session"
)

const (
	fixtureAgentID   = "fa9d0e2a-6f1b-4d4a-b3c2-d2cd7d5e7a91"
	fixtureWorkspace = "workspace-abc"
)

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

// buildFixtureStore writes a minimal Cursor `store.db` to <root>/<workspace>/<agent>/store.db
// populated with the meta header + a handful of blobs that exercise text,
// tool-call, and unparseable rows. Returns the full path to the store.db.
func buildFixtureStore(t *testing.T, root string) string {
	t.Helper()
	dir := filepath.Join(root, fixtureWorkspace, fixtureAgentID)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	dbPath := filepath.Join(dir, "store.db")

	db, err := sql.Open("sqlite", dbPath)
	require.NoError(t, err)
	defer func() { _ = db.Close() }()

	_, err = db.Exec(`CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);`)
	require.NoError(t, err)

	createdAt := time.Date(2026, 2, 14, 18, 30, 0, 0, time.UTC).UnixMilli()
	metaJSON, _ := json.Marshal(map[string]any{
		"agentId":          fixtureAgentID,
		"latestRootBlobId": "root",
		"name":             "test chat",
		"mode":             "default",
		"createdAt":        createdAt,
		"lastUsedModel":    "claude-sonnet-4-6",
	})
	_, err = db.Exec(`INSERT INTO meta(key, value) VALUES ('0', ?)`,
		hex.EncodeToString(metaJSON))
	require.NoError(t, err)

	type blob struct {
		id   string
		data []byte
	}
	mustJSON := func(v any) []byte {
		b, err := json.Marshal(v)
		require.NoError(t, err)
		return b
	}
	blobs := []blob{
		{
			id: "u1",
			data: mustJSON(map[string]any{
				"role": "user", "id": "u1",
				"content": []map[string]any{
					{"type": "text", "text": "explain quantum entanglement"},
				},
			}),
		},
		{
			id: "a1",
			data: mustJSON(map[string]any{
				"role": "assistant", "id": "a1",
				"content": []map[string]any{
					{"type": "text", "text": "two particles share state"},
					{"type": "tool-call", "toolName": "Read", "toolCallId": "tc1"},
				},
			}),
		},
		{
			id: "a2",
			data: mustJSON(map[string]any{
				"role": "assistant", "id": "a2",
				"content": []map[string]any{
					{"type": "tool-call", "toolName": "Read", "toolCallId": "tc2"},
					{"type": "tool-call", "toolName": "Bash", "toolCallId": "tc3"},
				},
			}),
		},
		// Plain protobuf-ish blob — first byte non-JSON, must be ignored.
		{id: "pb", data: []byte{0x00, 0x01, 0x02, 0x03}},
		// JSON that doesn't carry a role — must be ignored.
		{id: "meta", data: mustJSON(map[string]any{"name": "rootnode"})},
	}
	for _, b := range blobs {
		_, err = db.Exec(`INSERT INTO blobs(id, data) VALUES (?, ?)`, b.id, b.data)
		require.NoError(t, err)
	}
	return dbPath
}

func TestParseCursorStore(t *testing.T) {
	ctx := context.Background()

	root := filepath.Join(t.TempDir(), "cursor-root")
	src := buildFixtureStore(t, root)

	s, turns, tools, state, err := parseSession(ctx, src)
	require.NoError(t, err)
	require.Equal(t, session.UsageStateUnknown, state,
		"cursor never carries usage events; parser must report Unknown")

	require.Equal(t, fixtureAgentID, s.ID)
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "explain quantum entanglement", *s.FirstPrompt)
	require.NotNil(t, s.Model)
	require.Equal(t, "claude-sonnet-4-6", *s.Model)
	require.Equal(t, 2026, s.StartedAt.Year())
	require.Equal(t, time.February, s.StartedAt.Month())

	require.Len(t, turns, 2) // u1 + a1 (text). a2 is tool-call only → no text → no turn.
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, "explain quantum entanglement", turns[0].Content)
	require.Equal(t, "assistant", turns[1].Role)
	require.Equal(t, "two particles share state", turns[1].Content)

	require.Len(t, tools, 2)
	byName := map[string]int{}
	for _, tl := range tools {
		byName[tl.Name] = tl.Count
	}
	require.Equal(t, 2, byName["Read"])
	require.Equal(t, 1, byName["Bash"])
}

// TestImportCursorStoreAdmitsWithoutUsage covers the canonical Cursor
// case: store.db never records token counts by design, so every cursor
// session arrives with UsageStateUnknown. The importer admits it; the
// session shows up in sessions/projects/heatmap/tools and only the
// /analytics/usage view filters it out (via session_usage IS NULL).
func TestImportCursorStoreAdmitsWithoutUsage(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "cursor-root")
	src := buildFixtureStore(t, root)
	sink := newSink()

	res, err := New().Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped,
		"cursor sessions must admit despite having no usage signal (Unknown state)")
	require.Empty(t, res.SkipReason)
	require.Equal(t, fixtureAgentID, res.SessionID)
	require.Contains(t, sink.sessions, fixtureAgentID)
	stored := sink.sessions[fixtureAgentID]
	require.Nil(t, stored.Usage,
		"cursor sessions never project a usage aggregate")
	require.NotEmpty(t, res.RawPath, "raw .db bytes must still be preserved")
}

func TestWalkFindsStoreDb(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cursor-root")
	src := buildFixtureStore(t, root)
	// Drop a sibling file that must be ignored.
	require.NoError(t, os.WriteFile(filepath.Join(filepath.Dir(src), "store.db-wal"), []byte("x"), 0o644))

	imp := New()
	got, err := imp.Walk(context.Background(), root)
	require.NoError(t, err)
	require.Equal(t, []string{src}, got)
}

func TestWalkMissingRootReturnsEmpty(t *testing.T) {
	imp := New()
	got, err := imp.Walk(context.Background(), filepath.Join(t.TempDir(), "nope"))
	require.NoError(t, err)
	require.Empty(t, got)
}

// TestImportCursorSanitizesFirstPrompt covers the bug where Cursor user
// blobs carrying ANSI escape codes (e.g. captured shell output) and/or
// <local-command-stdout>…</local-command-stdout> wrappers leaked into
// FirstPrompt as garbled bytes. The sessiontext pipeline strips both.
// Calls parseSession directly because Cursor's store.db never carries
// per-message token usage so the importer's no-usage policy would
// otherwise skip the session before FirstPrompt got written.
func TestImportCursorSanitizesFirstPrompt(t *testing.T) {
	ctx := context.Background()

	root := filepath.Join(t.TempDir(), "cursor-root-dirty")
	const dirtyAgentID = "cc11dd22-1111-2222-3333-444455556666"
	dir := filepath.Join(root, "ws", dirtyAgentID)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	dbPath := filepath.Join(dir, "store.db")

	db, err := sql.Open("sqlite", dbPath)
	require.NoError(t, err)
	_, err = db.Exec(`CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);`)
	require.NoError(t, err)

	metaJSON, _ := json.Marshal(map[string]any{
		"agentId":       dirtyAgentID,
		"createdAt":     time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC).UnixMilli(),
		"lastUsedModel": "claude-sonnet-4-6",
	})
	_, err = db.Exec(`INSERT INTO meta(key, value) VALUES ('0', ?)`,
		hex.EncodeToString(metaJSON))
	require.NoError(t, err)

	dirtyText := "<local-command-stdout>Set model to \x1b[1mOpus 4.7\x1b[22m</local-command-stdout>\n" +
		"now refactor the sync logic"
	bodyJSON, _ := json.Marshal(map[string]any{
		"role": "user", "id": "u1",
		"content": []map[string]any{{"type": "text", "text": dirtyText}},
	})
	_, err = db.Exec(`INSERT INTO blobs(id, data) VALUES (?, ?)`, "u1", bodyJSON)
	require.NoError(t, err)
	require.NoError(t, db.Close())

	s, _, _, _, err := parseSession(ctx, dbPath)
	require.NoError(t, err)
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "now refactor the sync logic", *s.FirstPrompt,
		"FirstPrompt should drop the local-command-stdout wrapper and ANSI codes")
}
