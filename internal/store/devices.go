package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Device is the row stored in the devices table. ID is the stable
// per-machine fingerprint (see internal/device).
type Device struct {
	ID              string
	Hostname        string
	MachineID       string
	FriendlyName    string
	FingerprintedAt time.Time
}

// UpsertDevice writes (or updates) a device row. Existing FriendlyName
// is preserved when the caller passes an empty value, because the
// `prosa devices rename` command edits that field independent of sync.
func (s *Store) UpsertDevice(ctx context.Context, d Device) error {
	_, err := s.db.ExecContext(
		ctx, `
		INSERT INTO devices(id, hostname, machine_id, friendly_name, fingerprinted_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			hostname         = excluded.hostname,
			machine_id       = excluded.machine_id,
			friendly_name    = CASE
				WHEN excluded.friendly_name = '' THEN devices.friendly_name
				ELSE excluded.friendly_name
			END,
			fingerprinted_at = excluded.fingerprinted_at
	`,
		d.ID, d.Hostname, d.MachineID, d.FriendlyName, formatTime(d.FingerprintedAt),
	)
	if err != nil {
		return fmt.Errorf("upsert device %s: %w", d.ID, err)
	}
	return nil
}

// ListDevices returns every device row known to the store, ordered by
// most-recently fingerprinted first (with NULL — the seed row — last).
func (s *Store) ListDevices(ctx context.Context) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, hostname, machine_id, friendly_name, fingerprinted_at
		FROM devices
		ORDER BY fingerprinted_at DESC NULLS LAST
	`)
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []Device
	for rows.Next() {
		var (
			d  Device
			ts sql.NullString
		)
		if err := rows.Scan(&d.ID, &d.Hostname, &d.MachineID, &d.FriendlyName, &ts); err != nil {
			return nil, err
		}
		if ts.Valid {
			if t, ok := parseTime(ts.String); ok {
				d.FingerprintedAt = t
			}
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// RebindLocalSessions reassigns every `device_id = 'local'` session
// row to the given fingerprint, in one transaction. Returns the count
// rewritten. Used during startup to migrate sessions imported under
// the seed device id from earlier prosa runs (or the legacy bundle
// restore) to the real per-machine fingerprint.
//
// No-op when fingerprint == "local" (defensive: avoids a self-rewrite
// if the resolver ever returns the seed value).
// ListDevicesMap returns id → friendly_name for every device row,
// usable as a lookup table during render so the timeline can show
// human-readable device names instead of the raw fingerprint hex.
func (s *Store) ListDevicesMap(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT id, COALESCE(NULLIF(friendly_name, ''), hostname) FROM devices`,
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]string{}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

func (s *Store) RebindLocalSessions(ctx context.Context, fingerprint string) (int64, error) {
	if fingerprint == "" || fingerprint == "local" {
		return 0, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(
		ctx,
		`UPDATE sessions SET device_id = ? WHERE device_id = 'local'`,
		fingerprint,
	)
	if err != nil {
		return 0, fmt.Errorf("rebind sessions: %w", err)
	}
	n, _ := res.RowsAffected()
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return n, nil
}
