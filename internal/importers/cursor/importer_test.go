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

func TestImportCursorStore(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "cursor-root")
	src := buildFixtureStore(t, root)

	sink := newSink()
	imp := New()
	res, err := imp.Import(ctx, src, sink)
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.Equal(t, fixtureAgentID, res.SessionID)
	require.NotEmpty(t, res.RawHash)
	require.Greater(t, res.RawSize, int64(0))
	require.FileExists(t, res.RawPath)

	s := sink.sessions[fixtureAgentID]
	require.Equal(t, Name, s.Agent)
	require.Equal(t, "local", s.DeviceID)
	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, "explain quantum entanglement", *s.FirstPrompt)
	require.NotNil(t, s.Model)
	require.Equal(t, "claude-sonnet-4-6", *s.Model)
	require.Equal(t, 2026, s.StartedAt.Year())
	require.Equal(t, time.February, s.StartedAt.Month())

	turns := sink.turns[fixtureAgentID]
	require.Len(t, turns, 2) // u1 + a1 (text). a2 is tool-call only → no text → no turn.
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, "explain quantum entanglement", turns[0].Content)
	require.Equal(t, "assistant", turns[1].Role)
	require.Equal(t, "two particles share state", turns[1].Content)

	tools := sink.tools[fixtureAgentID]
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
