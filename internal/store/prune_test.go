package store

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func TestMigration0011AddsPushPruneColumns(t *testing.T) {
	t.Parallel()
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

	requireColumn("sync_state", "pushed_at")
	requireColumn("sync_state", "pushed_hash")
	requireColumn("sync_state", "remote_uri")
	requireColumn("sessions", "pruned_at")
}

func TestRecordPushedRoundTrip(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	now := time.Now().UTC()
	sess := newSession("push-1", now)
	require.NoError(t, s.UpsertSession(ctx, sess, nil))
	require.NoError(t, s.RecordSync(ctx, sess.ID, sess.RawHash))

	require.NoError(t, s.RecordPushed(ctx, sess.ID, sess.RawHash, "s3://bucket/key"))

	var pushedHash, remoteURI string
	require.NoError(t, s.DB().QueryRowContext(
		ctx,
		`SELECT pushed_hash, remote_uri FROM sync_state WHERE session_id = ?`, sess.ID,
	).Scan(&pushedHash, &remoteURI))
	require.Equal(t, sess.RawHash, pushedHash)
	require.Equal(t, "s3://bucket/key", remoteURI)

	// An idempotent re-push without a raw_uri keeps the recorded one.
	require.NoError(t, s.RecordPushed(ctx, sess.ID, sess.RawHash, ""))
	require.NoError(t, s.DB().QueryRowContext(
		ctx,
		`SELECT remote_uri FROM sync_state WHERE session_id = ?`, sess.ID,
	).Scan(&remoteURI))
	require.Equal(t, "s3://bucket/key", remoteURI)
}

func TestRecordPushedMissingSyncStateIsNoop(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	require.NoError(t, s.RecordPushed(ctx, "never-imported", "h", "s3://x"))
	var n int
	require.NoError(t, s.DB().QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sync_state`).Scan(&n))
	require.Zero(t, n)
}

func TestRecordPushedBatch(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	now := time.Now().UTC()
	for _, id := range []string{"b-1", "b-2"} {
		sess := newSession(id, now)
		require.NoError(t, s.UpsertSession(ctx, sess, nil))
		require.NoError(t, s.RecordSync(ctx, id, "deadbeef"))
	}

	backfilledAt := now.Add(-40 * 24 * time.Hour)
	require.NoError(t, s.RecordPushedBatch(ctx, map[string]PushedBackfill{
		"b-1": {Hash: "deadbeef", At: backfilledAt},
		"b-2": {Hash: "deadbeef", At: backfilledAt},
	}))

	var n int
	require.NoError(t, s.DB().QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sync_state WHERE pushed_hash = 'deadbeef'`).Scan(&n))
	require.Equal(t, 2, n)

	var pushedAt string
	require.NoError(t, s.DB().QueryRowContext(ctx,
		`SELECT pushed_at FROM sync_state WHERE session_id = 'b-1'`).Scan(&pushedAt))
	gotAt, ok := parseTime(pushedAt)
	require.True(t, ok)
	require.WithinDuration(t, backfilledAt, gotAt, time.Second)
}

// seedPrunable inserts a session with recorded import + push state, last
// active `ago` before now, and returns it.
func seedPrunable(t *testing.T, s *Store, id string, ago time.Duration) session.Session {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC()
	sess := newSession(id, now)
	sess.StartedAt = now.Add(-ago - time.Hour)
	sess.LastActivityAt = now.Add(-ago)
	require.NoError(t, s.UpsertSession(ctx, sess, nil))
	require.NoError(t, s.RecordSync(ctx, id, sess.RawHash))
	require.NoError(t, s.RecordPushed(ctx, id, sess.RawHash, "s3://bucket/"+id))
	return sess
}

func TestListPruneCandidatesAfterDeviceRebind(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	now := time.Now().UTC()

	canonical := Device{
		ID: "canon", Hostname: "tbox", MachineID: "uuid-1",
		FriendlyName: "tbox", FingerprintedAt: now,
	}
	stale := Device{
		ID: "stale", Hostname: "192.168.0.19", MachineID: "uuid-1",
		FriendlyName: "192.168.0.19", FingerprintedAt: now.Add(-time.Hour),
	}
	require.NoError(t, s.UpsertDevice(ctx, canonical))
	require.NoError(t, s.UpsertDevice(ctx, stale))

	sess := newSession("old-stale", now)
	sess.DeviceID = stale.ID
	sess.RawHash = "abc123hash"
	sess.StartedAt = now.Add(-60 * 24 * time.Hour)
	sess.LastActivityAt = now.Add(-40 * 24 * time.Hour)
	require.NoError(t, s.UpsertSession(ctx, sess, nil))
	require.NoError(t, s.RecordSync(ctx, sess.ID, sess.RawHash))
	require.NoError(t, s.RecordPushed(ctx, sess.ID, sess.RawHash, "s3://bucket/"+sess.ID))

	before := now.Add(-30 * 24 * time.Hour)
	got, err := s.ListPruneCandidates(ctx, canonical.ID, before, 0)
	require.NoError(t, err)
	require.Empty(t, got)

	n, err := s.RebindDevicesByMachineID(ctx, canonical)
	require.NoError(t, err)
	require.Equal(t, int64(1), n)

	got, err = s.ListPruneCandidates(ctx, canonical.ID, before, 0)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, sess.ID, got[0].ID)
	require.Equal(t, sess.RawHash, got[0].RawHash)
	require.Equal(t, sess.Agent, got[0].Agent)
}

func TestCountOldUnconfirmed(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	now := time.Now().UTC()
	before := now.Add(-30 * 24 * time.Hour)

	oldNull := newSession("old-null", now)
	oldNull.LastActivityAt = now.Add(-40 * 24 * time.Hour)
	require.NoError(t, s.UpsertSession(ctx, oldNull, nil))
	require.NoError(t, s.RecordSync(ctx, oldNull.ID, oldNull.RawHash))

	diverged := seedPrunable(t, s, "old-diverged", 40*24*time.Hour)
	require.NoError(t, s.RecordPushed(ctx, diverged.ID, "stale-hash", ""))

	seedPrunable(t, s, "old-confirmed", 40*24*time.Hour)

	recentNull := newSession("recent-null", now)
	recentNull.LastActivityAt = now.Add(-time.Hour)
	require.NoError(t, s.UpsertSession(ctx, recentNull, nil))
	require.NoError(t, s.RecordSync(ctx, recentNull.ID, recentNull.RawHash))

	pruned := newSession("old-pruned", now)
	pruned.LastActivityAt = now.Add(-40 * 24 * time.Hour)
	require.NoError(t, s.UpsertSession(ctx, pruned, nil))
	require.NoError(t, s.RecordSync(ctx, pruned.ID, pruned.RawHash))
	ok, err := s.MarkPruned(ctx, pruned.ID, pruned.RawHash)
	require.NoError(t, err)
	require.True(t, ok)

	require.NoError(t, s.UpsertDevice(ctx, Device{
		ID: "other", Hostname: "laptop", MachineID: "mid-other",
		FriendlyName: "laptop", FingerprintedAt: now,
	}))
	foreign := newSession("old-foreign", now)
	foreign.DeviceID = "other"
	foreign.LastActivityAt = now.Add(-40 * 24 * time.Hour)
	require.NoError(t, s.UpsertSession(ctx, foreign, nil))
	require.NoError(t, s.RecordSync(ctx, foreign.ID, foreign.RawHash))

	noState := newSession("old-no-sync-state", now)
	noState.LastActivityAt = now.Add(-40 * 24 * time.Hour)
	require.NoError(t, s.UpsertSession(ctx, noState, nil))

	n, err := s.CountOldUnconfirmed(ctx, "local", before)
	require.NoError(t, err)
	require.Equal(t, 2, n)
}

func TestListPruneCandidatesFilters(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	now := time.Now().UTC()

	seedPrunable(t, s, "old-pushed", 40*24*time.Hour)
	seedPrunable(t, s, "recent-pushed", time.Hour)

	// Pushed hash diverged from the current raw (raw grew after push).
	diverged := seedPrunable(t, s, "diverged", 40*24*time.Hour)
	require.NoError(t, s.RecordPushed(ctx, diverged.ID, "stale-hash", ""))

	// Old but never pushed.
	unpushed := newSession("unpushed", now)
	unpushed.LastActivityAt = now.Add(-40 * 24 * time.Hour)
	require.NoError(t, s.UpsertSession(ctx, unpushed, nil))
	require.NoError(t, s.RecordSync(ctx, unpushed.ID, unpushed.RawHash))

	// Already pruned.
	pruned := seedPrunable(t, s, "already-pruned", 40*24*time.Hour)
	ok, err := s.MarkPruned(ctx, pruned.ID, pruned.RawHash)
	require.NoError(t, err)
	require.True(t, ok)

	got, err := s.ListPruneCandidates(ctx, "local", now.Add(-30*24*time.Hour), 0)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "old-pushed", got[0].ID)
	require.Equal(t, "claude-code", got[0].Agent)
	require.Equal(t, int64(1024), got[0].RawSize)

	// Device scoping: nothing under an unknown device.
	got, err = s.ListPruneCandidates(ctx, "dev-zzz", now, 0)
	require.NoError(t, err)
	require.Empty(t, got)
}

func TestMarkPrunedGuards(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	sess := seedPrunable(t, s, "guard-1", 40*24*time.Hour)

	// Hash mismatch (raw changed since candidate listing) leaves the row alone.
	ok, err := s.MarkPruned(ctx, sess.ID, "some-other-hash")
	require.NoError(t, err)
	require.False(t, ok)

	ok, err = s.MarkPruned(ctx, sess.ID, sess.RawHash)
	require.NoError(t, err)
	require.True(t, ok)

	got, err := s.GetSession(ctx, sess.ID)
	require.NoError(t, err)
	require.NotNil(t, got.PrunedAt)

	// Double prune is a guarded no-op.
	ok, err = s.MarkPruned(ctx, sess.ID, sess.RawHash)
	require.NoError(t, err)
	require.False(t, ok)

	require.NoError(t, s.ClearPruned(ctx, sess.ID))
	got, err = s.GetSession(ctx, sess.ID)
	require.NoError(t, err)
	require.Nil(t, got.PrunedAt)
}

func TestUpsertSessionClearsPrunedAt(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	sess := seedPrunable(t, s, "unprune-1", 40*24*time.Hour)

	ok, err := s.MarkPruned(ctx, sess.ID, sess.RawHash)
	require.NoError(t, err)
	require.True(t, ok)

	// A re-import (changed source) rewrites the row and un-prunes it.
	sess.RawHash = "new-hash"
	require.NoError(t, s.UpsertSession(ctx, sess, nil))

	got, err := s.GetSession(ctx, sess.ID)
	require.NoError(t, err)
	require.Nil(t, got.PrunedAt)
	require.Equal(t, "new-hash", got.RawHash)
}

func TestPruneAdvisory(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	now := time.Now().UTC()

	seedPrunable(t, s, "adv-1", 40*24*time.Hour)
	seedPrunable(t, s, "adv-2", 50*24*time.Hour)
	seedPrunable(t, s, "adv-active", time.Hour)

	count, bytes, err := s.PruneAdvisory(ctx, "local",
		now.Add(-30*24*time.Hour), now.Add(time.Minute))
	require.NoError(t, err)
	require.Equal(t, 2, count)
	require.Equal(t, int64(2048), bytes)

	// Push grace: nothing counts when every push is more recent than the
	// pushedBefore cutoff.
	count, bytes, err = s.PruneAdvisory(ctx, "local",
		now.Add(-30*24*time.Hour), now.Add(-time.Hour))
	require.NoError(t, err)
	require.Zero(t, count)
	require.Zero(t, bytes)
}

func TestListSessionsManifestCarriesPruneState(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	sess := seedPrunable(t, s, "mani-1", 40*24*time.Hour)

	rows, err := s.ListSessionsManifest(ctx, "local", "", 0)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.False(t, rows[0].Pruned)
	require.Equal(t, sess.RawHash, rows[0].PushedHash)

	ok, err := s.MarkPruned(ctx, sess.ID, sess.RawHash)
	require.NoError(t, err)
	require.True(t, ok)

	rows, err = s.ListSessionsManifest(ctx, "local", "", 0)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.True(t, rows[0].Pruned)
}

func TestBoilerplateCandidatesExcludePruned(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	now := time.Now().UTC()

	mk := func(id string) session.Session {
		sess := newSession(id, now)
		sess.FirstPrompt = ptr("<local-command-stdout>noise</local-command-stdout>")
		return sess
	}
	require.NoError(t, s.UpsertSession(ctx, mk("bp-live"), nil))
	pruned := mk("bp-pruned")
	require.NoError(t, s.UpsertSession(ctx, pruned, nil))
	ok, err := s.MarkPruned(ctx, pruned.ID, pruned.RawHash)
	require.NoError(t, err)
	require.True(t, ok)

	got, err := s.ListSessionsWithBoilerplatePrompt(ctx, 0)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "bp-live", got[0].ID)
}
