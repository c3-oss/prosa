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

	"github.com/c3-oss/prosa/internal/importers/importertest"
	"github.com/c3-oss/prosa/pkg/importer"
	"github.com/c3-oss/prosa/pkg/session"
)

const (
	fixtureAgentID   = "fa9d0e2a-6f1b-4d4a-b3c2-d2cd7d5e7a91"
	fixtureWorkspace = "workspace-abc"
)

func newSink() *importertest.Sink {
	return importertest.NewSink()
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
	require.Contains(t, sink.Sessions, fixtureAgentID)
	stored := sink.Sessions[fixtureAgentID]
	require.Nil(t, stored.Usage,
		"cursor sessions never project a usage aggregate")
	require.NotEmpty(t, res.RawPath, "raw .db bytes must still be preserved")
}

// buildEmptyShellStore writes a freshly-initialized SQLite file with
// neither `meta` nor `blobs` table — the state Cursor leaves the file in
// for a brief window between creating `store.db` and running its initial
// `CREATE TABLE` statements on the first chat write. The importer must
// treat this as an empty shell and return a zero-value session rather
// than failing with "no such table: meta".
func buildEmptyShellStore(t *testing.T, root, agentID string) string {
	t.Helper()
	dir := filepath.Join(root, fixtureWorkspace, agentID)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	dbPath := filepath.Join(dir, "store.db")

	db, err := sql.Open("sqlite", dbPath)
	require.NoError(t, err)
	// Force the file to materialize on disk as a valid SQLite database
	// with no user tables. Create-then-drop guarantees the file is past
	// the "0 bytes" stage while still leaving meta/blobs absent.
	_, err = db.Exec(`CREATE TABLE _placeholder (id INTEGER); DROP TABLE _placeholder;`)
	require.NoError(t, err)
	require.NoError(t, db.Close())
	return dbPath
}

func TestParseCursorEmptyShell(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "cursor-empty-shell")
	const shellAgentID = "00000000-0000-0000-0000-000000000001"
	src := buildEmptyShellStore(t, root, shellAgentID)

	s, turns, tools, state, err := parseSession(ctx, src)
	require.NoError(t, err,
		"empty-shell store.db (no meta, no blobs) must not fail the parser; "+
			"it's the race window between mkdir and CREATE TABLE that triggered "+
			"the original `no such table: meta` field report")
	require.Equal(t, session.UsageStateUnknown, state)
	require.Empty(t, turns)
	require.Empty(t, tools)
	require.Empty(t, s.ID, "meta is absent → AgentID is empty; caller resolves the id from the path")
	require.Nil(t, s.FirstPrompt)
	require.Nil(t, s.Model)
	require.True(t, s.StartedAt.IsZero(),
		"with no meta there's no createdAt to read; StartedAt stays zero until the chat is populated")
}

func TestImportCursorEmptyShell(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "cursor-empty-shell-import")
	const shellAgentID = "00000000-0000-0000-0000-000000000002"
	src := buildEmptyShellStore(t, root, shellAgentID)
	sink := newSink()

	res, err := New().Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err,
		"importer must not propagate the missing-table error; the next sync "+
			"will pick up the populated file via the changed sha256")
	require.Equal(t, shellAgentID, res.SessionID,
		"with meta absent the session id falls back to the parent directory name")
	require.Contains(t, sink.Sessions, shellAgentID)
	require.Empty(t, sink.Turns[shellAgentID])
	require.Empty(t, sink.Tools[shellAgentID])
}

// TestParseCursorMetaTablePresentNoRow covers the other benign-empty path
// in readMeta: the meta table exists but has no key='0' row, so the Scan
// returns sql.ErrNoRows. The parser must treat this like the empty shell —
// a zero-value session, no error (see issue #70: the branch uses errors.Is
// so it survives any future error wrapping in the sql layer).
func TestParseCursorMetaTablePresentNoRow(t *testing.T) {
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), fixtureWorkspace, "00000000-0000-0000-0000-0000000000aa")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	dbPath := filepath.Join(dir, "store.db")

	db, err := sql.Open("sqlite", dbPath)
	require.NoError(t, err)
	_, err = db.Exec(`CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);`)
	require.NoError(t, err)
	require.NoError(t, db.Close())

	s, turns, tools, state, err := parseSession(ctx, dbPath)
	require.NoError(t, err, "meta table present but key='0' missing must be a benign empty result")
	require.Equal(t, session.UsageStateUnknown, state)
	require.Empty(t, turns)
	require.Empty(t, tools)
	require.Empty(t, s.ID)
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
