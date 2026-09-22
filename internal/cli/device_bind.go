package cli

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/c3-oss/prosa/internal/device"
	"github.com/c3-oss/prosa/internal/store"
)

// bindLocalDevice upserts this machine's fingerprint, moves sessions still
// tagged with the seed id onto it, and collapses other device rows that
// share its machine id. sync and prune both call it before they read by
// device id.
func bindLocalDevice(ctx context.Context, s *store.Store) (store.Device, error) {
	dev := store.Device{
		ID:              device.IDOnce(),
		Hostname:        device.Hostname(),
		MachineID:       device.MachineID(),
		FriendlyName:    device.FriendlyName(),
		FingerprintedAt: time.Now().UTC(),
	}
	if err := s.UpsertDevice(ctx, dev); err != nil {
		return store.Device{}, fmt.Errorf("upsert device: %w", err)
	}
	if n, err := s.RebindLocalSessions(ctx, dev.ID); err != nil {
		return store.Device{}, fmt.Errorf("rebind 'local' sessions to %s: %w", dev.ID, err)
	} else if n > 0 {
		slog.Info("rebound legacy 'local' sessions to fingerprint",
			"device_id", dev.ID, "rows", n)
	}
	if n, err := s.RebindDevicesByMachineID(ctx, dev); err != nil {
		return store.Device{}, fmt.Errorf("rebind devices by machine id: %w", err)
	} else if n > 0 {
		slog.Info("rebound sessions from stale device ids",
			"device_id", dev.ID, "rows", n)
	}
	return dev, nil
}
