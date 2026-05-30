package handlers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/minio/minio-go/v7"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/server/auth"
)

const (
	getRawDefaultLimit = 64 * 1024   // 64 KiB
	getRawMaxLimit     = 1024 * 1024 // 1 MiB
)

// GetRaw streams a byte-range window of the session's raw transcript
// from S3. Device callers may only read their own sessions; owner
// callers (panel) can read anyone's.
func (h *SessionsHandler) GetRaw(ctx context.Context, req *connect.Request[prosav1.GetRawRequest]) (*connect.Response[prosav1.GetRawResponse], error) {
	callerDevice, isDevice := auth.DeviceFromContext(ctx)
	if !isDevice && !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device or owner context"))
	}
	if req.Msg.Id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("id"))
	}
	if req.Msg.Offset < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("offset must be >= 0"))
	}

	var (
		rawURI   string
		deviceID string
	)
	err := h.Pool.QueryRow(
		ctx,
		`SELECT raw_uri, device_id FROM sessions WHERE id = $1`, req.Msg.Id,
	).Scan(&rawURI, &deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no session %s", req.Msg.Id))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("lookup session: %w", err))
	}
	if isDevice && !auth.IsOwner(ctx) && deviceID != callerDevice {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("session belongs to another device"))
	}

	bucket, key, err := parseS3URI(rawURI)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if bucket != h.Obj.Bucket {
		return nil, connect.NewError(connect.CodeInternal,
			fmt.Errorf("session %s raw_uri bucket mismatch: got %s want %s", req.Msg.Id, bucket, h.Obj.Bucket))
	}

	limit := int64(req.Msg.Limit)
	if limit <= 0 {
		limit = getRawDefaultLimit
	}
	if limit > getRawMaxLimit {
		limit = getRawMaxLimit
	}

	// Total size first so the response can carry it without a second
	// round-trip on the client.
	stat, err := h.Obj.Client.StatObject(ctx, h.Obj.Bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("stat object: %w", err))
	}
	total := stat.Size

	// EOF short-circuit: offset already past end.
	if req.Msg.Offset >= total {
		return connect.NewResponse(&prosav1.GetRawResponse{
			Chunk:     nil,
			TotalSize: total,
			Eof:       true,
		}), nil
	}

	opts := minio.GetObjectOptions{}
	end := req.Msg.Offset + limit - 1
	if end >= total {
		end = total - 1
	}
	if err := opts.SetRange(req.Msg.Offset, end); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("set range: %w", err))
	}
	obj, err := h.Obj.Client.GetObject(ctx, h.Obj.Bucket, key, opts)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("get object: %w", err))
	}
	defer func() { _ = obj.Close() }()

	chunk, err := io.ReadAll(obj)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("read chunk: %w", err))
	}

	return connect.NewResponse(&prosav1.GetRawResponse{
		Chunk:     chunk,
		TotalSize: total,
		Eof:       req.Msg.Offset+int64(len(chunk)) >= total,
	}), nil
}

// parseS3URI splits "s3://<bucket>/<key>" into its parts.
func parseS3URI(uri string) (bucket, key string, err error) {
	const prefix = "s3://"
	if !strings.HasPrefix(uri, prefix) {
		return "", "", fmt.Errorf("not an s3 uri: %q", uri)
	}
	rest := uri[len(prefix):]
	slash := strings.IndexByte(rest, '/')
	if slash <= 0 || slash == len(rest)-1 {
		return "", "", fmt.Errorf("malformed s3 uri: %q", uri)
	}
	return rest[:slash], rest[slash+1:], nil
}
