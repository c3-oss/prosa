package cli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/cli/rpc"
	"github.com/c3-oss/prosa/internal/device"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/rawlock"
	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/session"
)

// prunableFixtureSession seeds one pushed, inactive session whose raw_hash
// is the sha256 of the file on disk, and returns that path and hash.
func prunableFixtureSession(t *testing.T, fx *reconcileFixture, id string) (string, string) {
	t.Helper()
	ctx := context.Background()
	fx.addSession(t, ctx, "dev", id)
	old := time.Now().UTC().Add(-60 * 24 * time.Hour)
	_, err := fx.store.DB().ExecContext(ctx,
		`UPDATE sessions SET last_activity_at = ? WHERE id = ?`,
		old.Format(time.RFC3339Nano), id)
	require.NoError(t, err)
	sess, err := fx.store.GetSession(ctx, id)
	require.NoError(t, err)
	body, err := os.ReadFile(sess.RawPath)
	require.NoError(t, err)
	sum := sha256.Sum256(body)
	hash := hex.EncodeToString(sum[:])
	_, err = fx.store.DB().ExecContext(ctx,
		`UPDATE sessions SET raw_hash = ?, raw_size = ? WHERE id = ?`,
		hash, len(body), id)
	require.NoError(t, err)
	require.NoError(t, fx.store.RecordSync(ctx, id, hash))
	require.NoError(t, fx.store.RecordPushed(ctx, id, hash, "s3://bucket/"+id))
	return sess.RawPath, hash
}

func confirmedManifest(id, hash string) map[string]serverManifestRow {
	return map[string]serverManifestRow{
		id: {RawHash: hash, ProjectionVersion: session.ProjectionVersion},
	}
}

func TestPruneOneDeletesConfirmedRaw(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	rawPath, hash := prunableFixtureSession(t, fx, "s1")

	status, err := pruneOne(ctx, fx.store, confirmedManifest("s1", hash), mustCandidate(t, fx, "s1"))
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
	rawPath, _ := prunableFixtureSession(t, fx, "s1")

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
	rawPath, _ := prunableFixtureSession(t, fx, "s1")

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
	rawPath, hash := prunableFixtureSession(t, fx, "s1")

	serverHas := map[string]serverManifestRow{
		"s1": {RawHash: hash, ProjectionVersion: session.ProjectionVersion - 1},
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
	rawPath, hash := prunableFixtureSession(t, fx, "s1")
	require.NoError(t, os.Remove(rawPath))

	status, err := pruneOne(ctx, fx.store, confirmedManifest("s1", hash), mustCandidate(t, fx, "s1"))
	require.NoError(t, err)
	require.Equal(t, "pruned", status)
}

func TestPruneOneSecondRunIsSkipped(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	_, hash := prunableFixtureSession(t, fx, "s1")
	cand := mustCandidate(t, fx, "s1")

	status, err := pruneOne(ctx, fx.store, confirmedManifest("s1", hash), cand)
	require.NoError(t, err)
	require.Equal(t, "pruned", status)

	status, err = pruneOne(ctx, fx.store, confirmedManifest("s1", hash), cand)
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

func TestPruneOneSkipsWhenFileBytesChange(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	rawPath, hash := prunableFixtureSession(t, fx, "s1")
	require.NoError(t, os.WriteFile(rawPath, []byte("replaced-raw"), 0o644))

	status, err := pruneOne(ctx, fx.store, confirmedManifest("s1", hash), mustCandidate(t, fx, "s1"))
	require.ErrorIs(t, err, errRawChanged)
	require.Equal(t, "skipped", status)
	require.FileExists(t, rawPath)

	got, err := fx.store.GetSession(ctx, "s1")
	require.NoError(t, err)
	require.Nil(t, got.PrunedAt)
}

func TestPruneOneDoesNotUnlinkRawReplacedUnderLock(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	rawPath, hash := prunableFixtureSession(t, fx, "s1")
	cand := mustCandidate(t, fx, "s1")

	release, err := rawlock.Hold("s1")
	require.NoError(t, err)
	newBody := []byte("newer-raw-bytes")
	require.NoError(t, os.WriteFile(rawPath, newBody, 0o644))
	sum := sha256.Sum256(newBody)
	newHash := hex.EncodeToString(sum[:])
	_, err = fx.store.DB().ExecContext(ctx,
		`UPDATE sessions SET raw_hash = ?, raw_size = ? WHERE id = ?`,
		newHash, len(newBody), "s1")
	require.NoError(t, err)

	done := make(chan struct{})
	var status string
	var perr error
	go func() {
		status, perr = pruneOne(ctx, fx.store, confirmedManifest("s1", hash), cand)
		close(done)
	}()
	select {
	case <-done:
		release()
		t.Fatal("prune finished while the importer still held the raw lock")
	case <-time.After(50 * time.Millisecond):
	}
	release()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("prune did not finish after the raw lock was released")
	}
	require.NoError(t, perr)
	require.Equal(t, "skipped", status)
	body, err := os.ReadFile(rawPath)
	require.NoError(t, err)
	require.Equal(t, newBody, body)
	got, err := fx.store.GetSession(ctx, "s1")
	require.NoError(t, err)
	require.Nil(t, got.PrunedAt)
	require.Equal(t, newHash, got.RawHash)
}

func TestPruneJSONExitsNonZeroWhenDeleteFails(t *testing.T) {
	s := openPruneCommandStore(t)
	rawPath, hash := seedCommandSession(t, s, "locked", 60*24*time.Hour, []byte("raw-locked"))
	require.NoError(t, os.Chmod(filepath.Dir(rawPath), 0o555))
	t.Cleanup(func() { _ = os.Chmod(filepath.Dir(rawPath), 0o755) })

	restorePruneHooks(t)
	loadPruneManifest = func(context.Context, string, string) (map[string]serverManifestRow, error) {
		return confirmedManifest("locked", hash), nil
	}

	stdout, _ := captureStdoutStderr(t, func() {
		cmd := newRootCmd()
		cmd.SetArgs([]string{"--json", "prune"})
		err := cmd.Execute()
		require.ErrorContains(t, err, "prune finished with 1 errors")
	})
	require.NotContains(t, stdout, `"status":"pruned"`)
	require.Contains(t, stdout, `"status":"error"`)
	require.Contains(t, stdout, `"errors":1`)
	require.FileExists(t, rawPath)
	got, err := s.GetSession(context.Background(), "locked")
	require.NoError(t, err)
	require.Nil(t, got.PrunedAt)
}

func TestPruneLimitDoesNotCountServerSkips(t *testing.T) {
	s := openPruneCommandStore(t)
	skipPath, _ := seedCommandSession(t, s, "skip-old", 90*24*time.Hour, []byte("old"))
	keepPath, keepHash := seedCommandSession(t, s, "keep-new", 40*24*time.Hour, []byte("keep"))

	restorePruneHooks(t)
	loadPruneManifest = func(context.Context, string, string) (map[string]serverManifestRow, error) {
		return map[string]serverManifestRow{
			"skip-old": {RawHash: "not-the-file", ProjectionVersion: session.ProjectionVersion},
			"keep-new": {RawHash: keepHash, ProjectionVersion: session.ProjectionVersion},
		}, nil
	}

	_, stderr := captureStdoutStderr(t, func() {
		cmd := newRootCmd()
		cmd.SetArgs([]string{"prune", "--limit", "1"})
		require.NoError(t, cmd.Execute())
	})
	require.Contains(t, stderr, "pruned 1 sessions")
	require.FileExists(t, skipPath)
	require.NoFileExists(t, keepPath)
}

func TestPruneDryRunConfirmsWithServer(t *testing.T) {
	s := openPruneCommandStore(t)
	skipPath, _ := seedCommandSession(t, s, "skip-old", 90*24*time.Hour, []byte("old"))
	keepPath, keepHash := seedCommandSession(t, s, "keep-new", 40*24*time.Hour, []byte("keep"))

	restorePruneHooks(t)
	loadPruneManifest = func(context.Context, string, string) (map[string]serverManifestRow, error) {
		return map[string]serverManifestRow{
			"skip-old": {RawHash: "not-the-file", ProjectionVersion: session.ProjectionVersion},
			"keep-new": {RawHash: keepHash, ProjectionVersion: session.ProjectionVersion},
		}, nil
	}

	stdout, _ := captureStdoutStderr(t, func() {
		cmd := newRootCmd()
		cmd.SetArgs([]string{"--json", "prune", "--dry-run"})
		require.NoError(t, cmd.Execute())
	})
	require.NotContains(t, stdout, `"status":"pruned"`)
	require.Contains(t, stdout, `"status":"would_prune"`)
	require.Contains(t, stdout, `"status":"skipped"`)
	require.Contains(t, stdout, `"dry_run":true`)
	require.FileExists(t, skipPath)
	require.FileExists(t, keepPath)

	var sawWould, sawSkip bool
	for _, line := range splitLines(stdout) {
		var rec map[string]any
		require.NoError(t, json.Unmarshal([]byte(line), &rec))
		switch rec["session_id"] {
		case "keep-new":
			require.Equal(t, "would_prune", rec["status"])
			sawWould = true
		case "skip-old":
			require.Equal(t, "skipped", rec["status"])
			sawSkip = true
		}
	}
	require.True(t, sawWould)
	require.True(t, sawSkip)
}

func TestPruneDryRunErrorsWhenServerUnreachable(t *testing.T) {
	s := openPruneCommandStore(t)
	rawPath, _ := seedCommandSession(t, s, "s1", 60*24*time.Hour, []byte("raw"))

	restorePruneHooks(t)
	loadPruneManifest = func(context.Context, string, string) (map[string]serverManifestRow, error) {
		return nil, pruneNetTimeout{}
	}

	_, _ = captureStdoutStderr(t, func() {
		cmd := newRootCmd()
		cmd.SetArgs([]string{"prune", "--dry-run"})
		err := cmd.Execute()
		require.ErrorContains(t, err, "nothing was pruned")
	})
	require.FileExists(t, rawPath)
}

func restorePruneHooks(t *testing.T) {
	t.Helper()
	origG := g
	origManifest := loadPruneManifest
	origOlder := pruneOlderThanFlag
	origDry := pruneDryRunFlag
	origLimit := pruneLimitFlag
	t.Cleanup(func() {
		g = origG
		loadPruneManifest = origManifest
		pruneOlderThanFlag = origOlder
		pruneDryRunFlag = origDry
		pruneLimitFlag = origLimit
	})
}

func openPruneCommandStore(t *testing.T) *store.Store {
	t.Helper()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	t.Setenv("PROSA_CONFIG_HOME", filepath.Join(t.TempDir(), "config"))
	require.NoError(t, rpc.SaveAuth(rpc.AuthFile{
		Server: "http://127.0.0.1:9", Token: "tok", DeviceID: "d",
	}))
	ctx := context.Background()
	storePath, err := paths.StorePath()
	require.NoError(t, err)
	s, err := store.Open(ctx, storePath)
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	require.NoError(t, s.UpsertDevice(ctx, store.Device{
		ID:              device.IDOnce(),
		Hostname:        "host",
		MachineID:       "m",
		FriendlyName:    "fixture",
		FingerprintedAt: time.Now().UTC(),
	}))
	return s
}

func seedCommandSession(t *testing.T, s *store.Store, id string, ago time.Duration, body []byte) (string, string) {
	t.Helper()
	ctx := context.Background()
	root, err := paths.RawRoot("claude-code")
	require.NoError(t, err)
	dir := filepath.Join(root, "2020", "01")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	rawPath := filepath.Join(dir, id+".jsonl")
	require.NoError(t, os.WriteFile(rawPath, body, 0o644))
	sum := sha256.Sum256(body)
	hash := hex.EncodeToString(sum[:])
	now := time.Now().UTC()
	sess := session.Session{
		ID:             id,
		Agent:          "claude-code",
		DeviceID:       device.IDOnce(),
		StartedAt:      now.Add(-ago),
		LastActivityAt: now.Add(-ago),
		RawPath:        rawPath,
		RawHash:        hash,
		RawSize:        int64(len(body)),
		Usage:          &session.TokenUsage{TotalTokens: 1},
	}
	require.NoError(t, s.UpsertSession(ctx, sess, nil))
	require.NoError(t, s.RecordSync(ctx, id, hash))
	require.NoError(t, s.RecordPushed(ctx, id, hash, "s3://bucket/"+id))
	return rawPath, hash
}

func splitLines(s string) []string {
	var out []string
	for _, line := range bytesSplit(s) {
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

// pruneNetTimeout satisfies net.Error so prune treats the manifest fetch
// as "server unreachable" and deletes nothing.
type pruneNetTimeout struct{}

func (pruneNetTimeout) Error() string   { return "timeout" }
func (pruneNetTimeout) Timeout() bool   { return true }
func (pruneNetTimeout) Temporary() bool { return true }

func bytesSplit(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}
