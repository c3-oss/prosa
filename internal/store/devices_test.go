package store

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func TestUpsertDeviceRoundTrip(t *testing.T) {
	ctx, s := newStore(t)
	now := time.Now().UTC()

	d := Device{
		ID:              "abc123",
		Hostname:        "laptop",
		MachineID:       "raw-uuid-deadbeef",
		FriendlyName:    "laptop",
		FingerprintedAt: now,
	}
	require.NoError(t, s.UpsertDevice(ctx, d))

	devs, err := s.ListDevices(ctx)
	require.NoError(t, err)
	// The 'local' seed row + the new one.
	require.Len(t, devs, 2)
	var got *Device
	for i := range devs {
		if devs[i].ID == "abc123" {
			got = &devs[i]
		}
	}
	require.NotNil(t, got)
	require.Equal(t, "laptop", got.Hostname)
	require.Equal(t, "raw-uuid-deadbeef", got.MachineID)
	require.Equal(t, "laptop", got.FriendlyName)
}

func TestUpsertDevicePreservesFriendlyNameWhenEmpty(t *testing.T) {
	ctx, s := newStore(t)
	now := time.Now().UTC()

	require.NoError(t, s.UpsertDevice(ctx, Device{
		ID:              "abc",
		Hostname:        "host",
		MachineID:       "mid",
		FriendlyName:    "Mac Studio",
		FingerprintedAt: now,
	}))

	// Subsequent upsert with FriendlyName="" must NOT clobber Mac Studio.
	require.NoError(t, s.UpsertDevice(ctx, Device{
		ID:              "abc",
		Hostname:        "host",
		MachineID:       "mid",
		FriendlyName:    "",
		FingerprintedAt: now.Add(time.Hour),
	}))

	devs, err := s.ListDevices(ctx)
	require.NoError(t, err)
	for _, d := range devs {
		if d.ID == "abc" {
			require.Equal(t, "Mac Studio", d.FriendlyName)
			return
		}
	}
	t.Fatal("device abc not found")
}

func TestRebindLocalSessionsMovesRowsAtomic(t *testing.T) {
	ctx, s := newStore(t)
	now := time.Now().UTC()

	// Three sessions seeded to the 'local' device id.
	for _, id := range []string{"s1", "s2", "s3"} {
		sess := session.Session{
			ID:             id,
			Agent:          "claude-code",
			DeviceID:       "local",
			StartedAt:      now,
			LastActivityAt: now,
			RawPath:        "/tmp/" + id + ".jsonl",
			RawHash:        "h-" + id,
			RawSize:        10,
		}
		require.NoError(t, s.UpsertSession(ctx, sess, nil))
	}

	// New device row required so FK holds when sessions rebind.
	require.NoError(t, s.UpsertDevice(ctx, Device{
		ID:              "newdev",
		Hostname:        "host",
		MachineID:       "mid",
		FriendlyName:    "host",
		FingerprintedAt: now,
	}))

	n, err := s.RebindLocalSessions(ctx, "newdev")
	require.NoError(t, err)
	require.Equal(t, int64(3), n)

	// Re-run: idempotent, no rows left to move.
	n, err = s.RebindLocalSessions(ctx, "newdev")
	require.NoError(t, err)
	require.Equal(t, int64(0), n)
}

func TestRebindLocalSessionsRejectsSelfId(t *testing.T) {
	ctx, s := newStore(t)
	// "local" target is a defensive no-op.
	n, err := s.RebindLocalSessions(ctx, "local")
	require.NoError(t, err)
	require.Equal(t, int64(0), n)
}
