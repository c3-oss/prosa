package store

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func TestUpsertDeviceRoundTrip(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
	ctx, s := newStore(t)
	// "local" target is a defensive no-op.
	n, err := s.RebindLocalSessions(ctx, "local")
	require.NoError(t, err)
	require.Equal(t, int64(0), n)
}

func TestRebindDevicesByMachineIDCollapsesSameMachine(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	now := time.Now().UTC()

	canonical := Device{
		ID: "canon", Hostname: "tbox", MachineID: "uuid-1",
		FriendlyName: "tbox", FingerprintedAt: now,
	}
	staleA := Device{
		ID: "stale-a", Hostname: "192.168.0.19", MachineID: "uuid-1",
		FriendlyName: "192.168.0.19", FingerprintedAt: now.Add(-time.Hour),
	}
	staleB := Device{
		ID: "stale-b", Hostname: "ip-192-168-0-16", MachineID: "uuid-1",
		FriendlyName: "ip-192-168-0-16", FingerprintedAt: now.Add(-2 * time.Hour),
	}
	// Same machine, no sessions: the row is still removed.
	staleC := Device{
		ID: "stale-c", Hostname: "10.0.0.8", MachineID: "uuid-1",
		FriendlyName: "10.0.0.8", FingerprintedAt: now.Add(-3 * time.Hour),
	}
	foreign := Device{
		ID: "other", Hostname: "laptop", MachineID: "uuid-2",
		FriendlyName: "laptop", FingerprintedAt: now,
	}
	blank := Device{
		ID: "blank", Hostname: "noname", MachineID: "",
		FriendlyName: "noname", FingerprintedAt: now,
	}
	for _, d := range []Device{canonical, staleA, staleB, staleC, foreign, blank} {
		require.NoError(t, s.UpsertDevice(ctx, d))
	}

	seed := func(id, deviceID string) {
		t.Helper()
		sess := newSession(id, now)
		sess.DeviceID = deviceID
		require.NoError(t, s.UpsertSession(ctx, sess, nil))
	}
	// Two on the first stale id, one on the second, one already canonical,
	// one on a different machine, one on an empty machine id.
	seed("s1", "stale-a")
	seed("s2", "stale-a")
	seed("s3", "stale-b")
	seed("s4", "canon")
	seed("s5", "other")
	seed("s6", "blank")

	n, err := s.RebindDevicesByMachineID(ctx, canonical)
	require.NoError(t, err)
	require.Equal(t, int64(3), n)

	var total int
	require.NoError(t, s.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions`).Scan(&total))
	require.Equal(t, 6, total)

	wantDevice := map[string]string{
		"s1": "canon",
		"s2": "canon",
		"s3": "canon",
		"s4": "canon",
		"s5": "other",
		"s6": "blank",
	}
	for id, want := range wantDevice {
		var got string
		require.NoError(t, s.DB().QueryRowContext(ctx,
			`SELECT device_id FROM sessions WHERE id = ?`, id).Scan(&got))
		require.Equal(t, want, got, id)
	}

	devs, err := s.ListDevices(ctx)
	require.NoError(t, err)
	gotIDs := map[string]struct{}{}
	for _, d := range devs {
		gotIDs[d.ID] = struct{}{}
	}
	require.Contains(t, gotIDs, "canon")
	require.Contains(t, gotIDs, "other")
	require.Contains(t, gotIDs, "blank")
	require.Contains(t, gotIDs, "local")
	require.NotContains(t, gotIDs, "stale-a")
	require.NotContains(t, gotIDs, "stale-b")
	require.NotContains(t, gotIDs, "stale-c")

	n, err = s.RebindDevicesByMachineID(ctx, canonical)
	require.NoError(t, err)
	require.Equal(t, int64(0), n)

	devs, err = s.ListDevices(ctx)
	require.NoError(t, err)
	require.Len(t, devs, 4)
}

func TestRebindDevicesByMachineIDIgnoresEmptyMachineID(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	now := time.Now().UTC()

	a := Device{ID: "a", Hostname: "a", MachineID: "", FriendlyName: "a", FingerprintedAt: now}
	b := Device{ID: "b", Hostname: "b", MachineID: "", FriendlyName: "b", FingerprintedAt: now}
	require.NoError(t, s.UpsertDevice(ctx, a))
	require.NoError(t, s.UpsertDevice(ctx, b))

	sess := newSession("s", now)
	sess.DeviceID = "b"
	require.NoError(t, s.UpsertSession(ctx, sess, nil))

	n, err := s.RebindDevicesByMachineID(ctx, a)
	require.NoError(t, err)
	require.Equal(t, int64(0), n)

	var got string
	require.NoError(t, s.DB().QueryRowContext(ctx,
		`SELECT device_id FROM sessions WHERE id = 's'`).Scan(&got))
	require.Equal(t, "b", got)

	devs, err := s.ListDevices(ctx)
	require.NoError(t, err)
	ids := map[string]struct{}{}
	for _, d := range devs {
		ids[d.ID] = struct{}{}
	}
	require.Contains(t, ids, "a")
	require.Contains(t, ids, "b")
}
