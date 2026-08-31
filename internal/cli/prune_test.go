package cli

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/session"
)

// prunableFixtureSession seeds one pushed, inactive session with a real raw
// file and returns its raw path.
func prunableFixtureSession(t *testing.T, fx *reconcileFixture, id string) string {
	t.Helper()
	ctx := context.Background()
	fx.addSession(t, ctx, "dev", id)
	old := time.Now().UTC().Add(-60 * 24 * time.Hour)
	_, err := fx.store.DB().ExecContext(ctx,
		`UPDATE sessions SET last_activity_at = ? WHERE id = ?`,
		old.Format(time.RFC3339Nano), id)
	require.NoError(t, err)
	require.NoError(t, fx.store.RecordSync(ctx, id, "h-"+id))
	require.NoError(t, fx.store.RecordPushed(ctx, id, "h-"+id, "s3://bucket/"+id))
	sess, err := fx.store.GetSession(ctx, id)
	require.NoError(t, err)
	return sess.RawPath
}

func confirmedManifest(ids ...string) map[string]serverManifestRow {
	out := map[string]serverManifestRow{}
	for _, id := range ids {
		out[id] = serverManifestRow{RawHash: "h-" + id, ProjectionVersion: session.ProjectionVersion}
	}
	return out
}

func TestPruneOneDeletesConfirmedRaw(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	rawPath := prunableFixtureSession(t, fx, "s1")

	status, err := pruneOne(ctx, fx.store, confirmedManifest("s1"), mustCandidate(t, fx, "s1"))
	require.NoError(t, err)
	require.Equal(t, "pruned", status)
	require.NoFileExists(t, rawPath)

	got, err := fx.store.GetSession(ctx, "s1")
	require.NoError(t, err)
	require.NotNil(t, got.PrunedAt)
}

func TestPruneOneSkipsWhenServerLacksSession(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	rawPath := prunableFixtureSession(t, fx, "s1")

	status, err := pruneOne(ctx, fx.store, map[string]serverManifestRow{}, mustCandidate(t, fx, "s1"))
	require.Error(t, err)
	require.Equal(t, "skipped", status)
	require.FileExists(t, rawPath)

	got, err := fx.store.GetSession(ctx, "s1")
	require.NoError(t, err)
	require.Nil(t, got.PrunedAt)
}

func TestPruneOneSkipsOnServerHashMismatch(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	rawPath := prunableFixtureSession(t, fx, "s1")

	serverHas := map[string]serverManifestRow{
		"s1": {RawHash: "other", ProjectionVersion: session.ProjectionVersion},
	}
	status, err := pruneOne(ctx, fx.store, serverHas, mustCandidate(t, fx, "s1"))
	require.Error(t, err)
	require.Equal(t, "skipped", status)
	require.FileExists(t, rawPath)
}

func TestPruneOneSkipsOnStaleServerProjection(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	rawPath := prunableFixtureSession(t, fx, "s1")

	serverHas := map[string]serverManifestRow{
		"s1": {RawHash: "h-s1", ProjectionVersion: session.ProjectionVersion - 1},
	}
	status, err := pruneOne(ctx, fx.store, serverHas, mustCandidate(t, fx, "s1"))
	require.Error(t, err)
	require.ErrorContains(t, err, "projection")
	require.Equal(t, "skipped", status)
	require.FileExists(t, rawPath)
}

func TestPruneOneAlreadyMissingFileStillPrunes(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	rawPath := prunableFixtureSession(t, fx, "s1")
	require.NoError(t, os.Remove(rawPath))

	status, err := pruneOne(ctx, fx.store, confirmedManifest("s1"), mustCandidate(t, fx, "s1"))
	require.NoError(t, err)
	require.Equal(t, "pruned", status)
}

func TestPruneOneSecondRunIsSkipped(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	prunableFixtureSession(t, fx, "s1")
	cand := mustCandidate(t, fx, "s1")

	status, err := pruneOne(ctx, fx.store, confirmedManifest("s1"), cand)
	require.NoError(t, err)
	require.Equal(t, "pruned", status)

	status, err = pruneOne(ctx, fx.store, confirmedManifest("s1"), cand)
	require.NoError(t, err)
	require.Equal(t, "skipped", status)
}

func TestPruneCommandRequiresLogin(t *testing.T) {
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	t.Setenv("PROSA_CONFIG_HOME", filepath.Join(t.TempDir(), "config"))
	originalFlags := g
	t.Cleanup(func() { g = originalFlags })

	cmd := newRootCmd()
	cmd.SetArgs([]string{"prune"})
	err := cmd.Execute()
	require.ErrorContains(t, err, "prosa login")
}

func TestRemoveEmptyRawDirs(t *testing.T) {
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root, err := paths.RawRoot("claude-code")
	require.NoError(t, err)
	empty := filepath.Join(root, "2025", "01")
	kept := filepath.Join(root, "2025", "02")
	require.NoError(t, os.MkdirAll(empty, 0o755))
	require.NoError(t, os.MkdirAll(kept, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(kept, "s.jsonl"), []byte("x"), 0o644))

	removeEmptyRawDirs(map[string]struct{}{"claude-code": {}})

	require.NoDirExists(t, empty)
	require.DirExists(t, kept)
	require.DirExists(t, root)
}

func TestHumanBytes(t *testing.T) {
	require.Equal(t, "512 B", humanBytes(512))
	require.Equal(t, "1.0 KiB", humanBytes(1024))
	require.Equal(t, "8.3 GiB", humanBytes(8912896000))
}

// mustCandidate builds the prune candidate for an already seeded session.
func mustCandidate(t *testing.T, fx *reconcileFixture, id string) store.PruneCandidate {
	t.Helper()
	sess, err := fx.store.GetSession(context.Background(), id)
	require.NoError(t, err)
	return store.PruneCandidate{
		ID:             sess.ID,
		Agent:          sess.Agent,
		RawPath:        sess.RawPath,
		RawHash:        sess.RawHash,
		RawSize:        sess.RawSize,
		LastActivityAt: sess.LastActivityAt,
	}
}
