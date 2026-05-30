package handlers

import (
	"context"
	"errors"
	"fmt"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
)

// DevicesHandler implements the DevicesService Connect interface.
type DevicesHandler struct {
	prosav1connect.UnimplementedDevicesServiceHandler
	Pool *pgxpool.Pool
}

// NewDevicesHandler wires the handler.
func NewDevicesHandler(pool *pgxpool.Pool) *DevicesHandler {
	return &DevicesHandler{Pool: pool}
}

// List returns every device row known to the server. Revoked devices
// are included with the revoked field set so the panel can show them
// dimmed; clients usually filter.
func (h *DevicesHandler) List(ctx context.Context, _ *connect.Request[prosav1.DevicesServiceListRequest]) (*connect.Response[prosav1.DevicesServiceListResponse], error) {
	if _, ok := auth.DeviceFromContext(ctx); !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device context"))
	}
	rows, err := h.Pool.Query(ctx, `
		SELECT d.id, d.hostname, d.friendly_name, d.fingerprinted_at, d.last_sync,
		       COALESCE(s.cnt, 0) AS sessions,
		       d.revoked_at IS NOT NULL AS revoked
		FROM devices d
		LEFT JOIN (
			SELECT device_id, COUNT(*) AS cnt FROM sessions GROUP BY device_id
		) s ON s.device_id = d.id
		ORDER BY d.fingerprinted_at DESC NULLS LAST
	`)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	defer rows.Close()

	out := &prosav1.DevicesServiceListResponse{}
	for rows.Next() {
		var (
			d                      prosav1.Device
			fingerprinted          time.Time
			lastSync               *time.Time
			revoked                bool
			sessions               int32
			id, hostname, friendly string
		)
		if err := rows.Scan(&id, &hostname, &friendly, &fingerprinted, &lastSync, &sessions, &revoked); err != nil {
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		d.Id = id
		d.Hostname = hostname
		d.FriendlyName = friendly
		d.FingerprintedAt = timestamppb.New(fingerprinted)
		if lastSync != nil {
			d.LastSync = timestamppb.New(*lastSync)
		}
		d.Sessions = sessions
		d.Revoked = revoked
		out.Devices = append(out.Devices, &d)
	}
	return connect.NewResponse(out), rows.Err()
}

// Rename sets devices.friendly_name. Accepts id="self" → caller's id.
// Renaming another device requires the admin token (not implemented in
// this cut; surface a clear PermissionDenied so callers know to use
// --admin in the panel/future devices CLI).
func (h *DevicesHandler) Rename(ctx context.Context, req *connect.Request[prosav1.RenameRequest]) (*connect.Response[prosav1.RenameResponse], error) {
	caller, ok := auth.DeviceFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device context"))
	}
	target := req.Msg.Id
	if target == "" || target == "self" {
		target = caller
	}
	if target != caller {
		return nil, connect.NewError(connect.CodePermissionDenied,
			fmt.Errorf("can only rename own device; got %s", target))
	}
	if req.Msg.FriendlyName == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("friendly_name"))
	}
	if _, err := h.Pool.Exec(
		ctx,
		`UPDATE devices SET friendly_name = $1 WHERE id = $2`,
		req.Msg.FriendlyName, target,
	); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	d, err := readDevice(ctx, h.Pool, target)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&prosav1.RenameResponse{Device: d}), nil
}

// Revoke marks all device_tokens for the target as revoked and stamps
// devices.revoked_at. Same scoping as Rename: only "self" works until
// the admin claim ships with the panel.
func (h *DevicesHandler) Revoke(ctx context.Context, req *connect.Request[prosav1.RevokeRequest]) (*connect.Response[prosav1.RevokeResponse], error) {
	caller, ok := auth.DeviceFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device context"))
	}
	target := req.Msg.Id
	if target == "" || target == "self" {
		target = caller
	}
	if target != caller {
		return nil, connect.NewError(connect.CodePermissionDenied,
			fmt.Errorf("can only revoke own device; got %s", target))
	}
	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	now := time.Now().UTC()
	if _, err := tx.Exec(
		ctx,
		`UPDATE device_tokens SET revoked_at = $1 WHERE device_id = $2 AND revoked_at IS NULL`,
		now, target,
	); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE devices SET revoked_at = $1 WHERE id = $2`,
		now, target,
	); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&prosav1.RevokeResponse{}), nil
}

func readDevice(ctx context.Context, pool *pgxpool.Pool, id string) (*prosav1.Device, error) {
	var (
		hostname, friendly string
		fingerprinted      time.Time
		lastSync           *time.Time
		revoked            bool
		sessions           int32
	)
	err := pool.QueryRow(ctx, `
		SELECT d.hostname, d.friendly_name, d.fingerprinted_at, d.last_sync,
		       COALESCE(s.cnt, 0) AS sessions,
		       d.revoked_at IS NOT NULL AS revoked
		FROM devices d
		LEFT JOIN (
			SELECT device_id, COUNT(*) AS cnt FROM sessions GROUP BY device_id
		) s ON s.device_id = d.id
		WHERE d.id = $1
	`, id).Scan(&hostname, &friendly, &fingerprinted, &lastSync, &sessions, &revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("device %s not found", id)
	}
	if err != nil {
		return nil, err
	}
	d := &prosav1.Device{
		Id:              id,
		Hostname:        hostname,
		FriendlyName:    friendly,
		FingerprintedAt: timestamppb.New(fingerprinted),
		Sessions:        sessions,
		Revoked:         revoked,
	}
	if lastSync != nil {
		d.LastSync = timestamppb.New(*lastSync)
	}
	return d, nil
}
