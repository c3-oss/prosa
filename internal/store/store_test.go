package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func newStore(t *testing.T) (context.Context, *Store) {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "store.db")
	s, err := Open(ctx, path)
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	return ctx, s
}

func ptr(s string) *string { return &s }

func newSession(id string, now time.Time) session.Session {
	return session.Session{
		ID:             id,
		Agent:          "claude-code",
		DeviceID:       "local",
		ProjectPath:    ptr("/Users/test/proj"),
		StartedAt:      now.Add(-time.Hour),
		LastActivityAt: now.Add(-30 * time.Minute),
		FirstPrompt:    ptr("hello world"),
		Model:          ptr("claude-sonnet-4-6"),
		RawPath:        "/tmp/raw/" + id + ".jsonl",
		RawHash:        "deadbeef",
		RawSize:        1024,
	}
}

func TestOpenAndMigrate(t *testing.T) {
	ctx, s := newStore(t)
	// devices seed row must be present so the FK on sessions works.
	var n int
	require.NoError(t, s.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM devices WHERE id = 'local'`).Scan(&n))
	require.Equal(t, 1, n)

	// schema_migrations should be at the latest version.
	var version int
	require.NoError(t, s.DB().QueryRowContext(ctx, `SELECT MAX(version) FROM schema_migrations`).Scan(&version))
	require.GreaterOrEqual(t, version, 2)
}

func TestMigration0002AddsIdentityColumns(t *testing.T) {
	ctx, s := newStore(t)

	requireColumn := func(table, col string) {
		t.Helper()
		rows, err := s.DB().QueryContext(ctx, "PRAGMA table_info("+table+")")
		require.NoError(t, err)
		defer func() { _ = rows.Close() }()
		var found bool
		for rows.Next() {
			var cid int
			var name, ctype string
			var notnull, pk int
			var dflt any
			require.NoError(t, rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk))
			if name == col {
				found = true
			}
		}
		require.True(t, found, "table %s missing column %s", table, col)
	}

	requireColumn("sessions", "project_remote")
	requireColumn("sessions", "project_marker")
	requireColumn("devices", "fingerprinted_at")
}

func TestUpsertSessionIdempotent(t *testing.T) {
	ctx, s := newStore(t)
	now := time.Now().UTC()
	sess := newSession("sess-1", now)
	tools := []session.ToolUsage{{Name: "Bash", Count: 5}, {Name: "Read", Count: 12}}

	require.NoError(t, s.UpsertSession(ctx, sess, tools))
	// Second call must succeed (idempotency).
	require.NoError(t, s.UpsertSession(ctx, sess, tools))

	list, err := s.ListSessionsByRange(ctx, now.Add(-2*time.Hour), now)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, "sess-1", list[0].ID)
	require.Equal(t, "claude-code", list[0].Agent)
	require.NotNil(t, list[0].ProjectPath)
	require.Equal(t, "/Users/test/proj", *list[0].ProjectPath)

	got, err := s.GetSession(ctx, "sess-1")
	require.NoError(t, err)
	require.Equal(t, sess.ID, got.ID)
	require.Equal(t, sess.RawHash, got.RawHash)
}

func TestSessionToolsReplaced(t *testing.T) {
	ctx, s := newStore(t)
	now := time.Now().UTC()
	sess := newSession("sess-2", now)

	require.NoError(t, s.UpsertSession(ctx, sess, []session.ToolUsage{{Name: "Old", Count: 1}}))
	require.NoError(t, s.UpsertSession(ctx, sess, []session.ToolUsage{{Name: "New", Count: 2}}))

	var name string
	require.NoError(t, s.DB().QueryRowContext(ctx, `SELECT name FROM session_tools WHERE session_id = 'sess-2'`).Scan(&name))
	require.Equal(t, "New", name)
}

func TestInsertTurnsAndFTS(t *testing.T) {
	ctx, s := newStore(t)
	now := time.Now().UTC()
	sess := newSession("sess-3", now)
	require.NoError(t, s.UpsertSession(ctx, sess, nil))

	turns := []session.Turn{
		{Role: "user", Content: "explain quantum entanglement", Timestamp: now.Add(-50 * time.Minute)},
		{Role: "assistant", Content: "quantum entanglement is a phenomenon where particles remain connected", Timestamp: now.Add(-49 * time.Minute)},
	}
	require.NoError(t, s.InsertTurns(ctx, sess.ID, turns))

	// Re-insert with different turns to confirm idempotency (delete-then-insert).
	require.NoError(t, s.InsertTurns(ctx, sess.ID, []session.Turn{
		{Role: "user", Content: "totally different prompt", Timestamp: now.Add(-10 * time.Minute)},
	}))

	var count int
	require.NoError(t, s.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM turns WHERE session_id = 'sess-3'`).Scan(&count))
	require.Equal(t, 1, count)

	// FTS5 trigger should mirror turns.
	var ftsCount int
	require.NoError(t, s.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM turns_fts WHERE turns_fts MATCH 'different'`).Scan(&ftsCount))
	require.Equal(t, 1, ftsCount)
}

func TestSyncStateRoundTrip(t *testing.T) {
	ctx, s := newStore(t)
	now := time.Now().UTC()
	sess := newSession("sess-4", now)
	require.NoError(t, s.UpsertSession(ctx, sess, nil))

	_, found, err := s.LastHash(ctx, sess.ID)
	require.NoError(t, err)
	require.False(t, found)

	require.NoError(t, s.RecordSync(ctx, sess.ID, "h1"))
	h, found, err := s.LastHash(ctx, sess.ID)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "h1", h)

	require.NoError(t, s.RecordSync(ctx, sess.ID, "h2"))
	h, _, err = s.LastHash(ctx, sess.ID)
	require.NoError(t, err)
	require.Equal(t, "h2", h)
}

func TestLastHashIgnoresStaleProjectionVersion(t *testing.T) {
	ctx, s := newStore(t)
	now := time.Now().UTC()
	sess := newSession("sess-stale-projection", now)
	require.NoError(t, s.UpsertSession(ctx, sess, nil))

	_, err := s.DB().ExecContext(ctx, `
		INSERT INTO sync_state (session_id, last_hash, last_synced_at, projection_version)
		VALUES (?, ?, ?, ?)
	`, sess.ID, "stale-hash", formatTime(now), session.ProjectionVersion-1)
	require.NoError(t, err)

	hash, found, err := s.LastHash(ctx, sess.ID)
	require.NoError(t, err)
	require.False(t, found)
	require.Equal(t, "stale-hash", hash)
}
