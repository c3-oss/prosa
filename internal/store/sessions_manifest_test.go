package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

// seedManifestStore writes a small set of sessions across two devices so
// the manifest tests can exercise both the device-scoping filter and
// the cursor paging path.
func seedManifestStore(t *testing.T) (context.Context, *Store) {
	t.Helper()
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "store.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })

	// Both fingerprints need to exist in `devices` because of the FK on
	// `sessions.device_id`.
	for _, devID := range []string{"dev-a", "dev-b"} {
		require.NoError(t, s.UpsertDevice(ctx, Device{
			ID:              devID,
			Hostname:        devID,
			MachineID:       "machine-" + devID,
			FriendlyName:    devID,
			FingerprintedAt: time.Now().UTC(),
		}))
	}

	now := time.Now().UTC()
	mk := func(id, devID string, ago time.Duration) session.Session {
		return session.Session{
			ID:             id,
			Agent:          "claude-code",
			DeviceID:       devID,
			StartedAt:      now.Add(-ago),
			LastActivityAt: now.Add(-ago + time.Minute),
			RawPath:        "/tmp/" + id + ".jsonl",
			RawHash:        "h-" + id,
			RawSize:        100,
		}
	}

	// dev-a: a01..a05 in lexical order (id chosen to match the ORDER BY
	// id ASC the manifest uses); dev-b: b01 b02 to exercise the
	// device_id isolation.
	require.NoError(t, s.UpsertSession(ctx, mk("a01", "dev-a", 5*time.Hour), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("a02", "dev-a", 4*time.Hour), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("a03", "dev-a", 3*time.Hour), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("a04", "dev-a", 2*time.Hour), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("a05", "dev-a", 1*time.Hour), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("b01", "dev-b", 6*time.Hour), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("b02", "dev-b", 7*time.Hour), nil))

	return ctx, s
}

func TestListSessionsManifestAllInOnePage(t *testing.T) {
	ctx, s := seedManifestStore(t)
	rows, err := s.ListSessionsManifest(ctx, "dev-a", "", 0)
	require.NoError(t, err)
	require.Len(t, rows, 5)
	// Ordered by id ASC so paging cursors don't overlap.
	require.Equal(t, "a01", rows[0].ID)
	require.Equal(t, "a05", rows[4].ID)
	// Round-tripped fields used by the reconcile diff.
	require.Equal(t, "h-a01", rows[0].RawHash)
	require.Equal(t, "/tmp/a01.jsonl", rows[0].RawPath)
}

func TestListSessionsManifestDeviceIsolation(t *testing.T) {
	ctx, s := seedManifestStore(t)
	rows, err := s.ListSessionsManifest(ctx, "dev-b", "", 0)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, "b01", rows[0].ID)
	require.Equal(t, "b02", rows[1].ID)
}

func TestListSessionsManifestPagination(t *testing.T) {
	ctx, s := seedManifestStore(t)

	// Page 1: limit 2, cursor empty → a01,a02.
	page1, err := s.ListSessionsManifest(ctx, "dev-a", "", 2)
	require.NoError(t, err)
	require.Len(t, page1, 2)
	require.Equal(t, "a01", page1[0].ID)
	require.Equal(t, "a02", page1[1].ID)

	// Page 2: cursor=a02 → a03,a04.
	page2, err := s.ListSessionsManifest(ctx, "dev-a", "a02", 2)
	require.NoError(t, err)
	require.Len(t, page2, 2)
	require.Equal(t, "a03", page2[0].ID)
	require.Equal(t, "a04", page2[1].ID)

	// Page 3: cursor=a04 → a05 only (partial page).
	page3, err := s.ListSessionsManifest(ctx, "dev-a", "a04", 2)
	require.NoError(t, err)
	require.Len(t, page3, 1)
	require.Equal(t, "a05", page3[0].ID)

	// Page 4: cursor=a05 → empty.
	page4, err := s.ListSessionsManifest(ctx, "dev-a", "a05", 2)
	require.NoError(t, err)
	require.Empty(t, page4)
}

func TestListSessionsManifestUnknownDevice(t *testing.T) {
	ctx, s := seedManifestStore(t)
	rows, err := s.ListSessionsManifest(ctx, "dev-zzz", "", 0)
	require.NoError(t, err)
	require.Empty(t, rows)
}
