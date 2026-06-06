package handlers

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
)

const pushChunkBearer = "device-bearer"

// chunkSession builds the per-chunk Session header (constant across an upload).
func chunkSession(id string, started time.Time, rawSize int64, rawHash string) *prosav1.Session {
	return &prosav1.Session{
		Id:             id,
		Agent:          "codex",
		StartedAt:      timestamppb.New(started),
		LastActivityAt: timestamppb.New(started),
		RawHash:        rawHash,
		RawSize:        rawSize,
	}
}

func sendChunk(ctx context.Context, client prosav1connect.SessionsServiceClient, msg *prosav1.PushChunkRequest) (*connect.Response[prosav1.PushChunkResponse], error) {
	r := connect.NewRequest(msg)
	r.Header().Set("Authorization", "Bearer "+pushChunkBearer)
	return client.PushChunk(ctx, r)
}

func newChunkTestClient(t *testing.T, ctx context.Context) (prosav1connect.SessionsServiceClient, time.Time) {
	t.Helper()
	pool := newHandlersPostgresPool(t, ctx)
	obj := newTestObjectStore(t)
	insertDeviceToken(t, ctx, pool, "device-a", pushChunkBearer)
	client := newPushClient(t, pool, obj, "admin-token")
	return client, time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
}

func TestPushChunkRejectsOffsetOutOfRange(t *testing.T) {
	ctx := context.Background()
	client, started := newChunkTestClient(t, ctx)

	_, err := sendChunk(ctx, client, &prosav1.PushChunkRequest{
		Session:  chunkSession("oob", started, 8, sha256Hex([]byte("abcdefgh"))),
		Offset:   100, // > raw size
		RawChunk: []byte("x"),
	})
	require.Error(t, err)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestPushChunkRejectsGapAndOverlap(t *testing.T) {
	ctx := context.Background()
	client, started := newChunkTestClient(t, ctx)

	raw := []byte("abcdefgh") // 8 bytes
	hash := sha256Hex(raw)
	t.Cleanup(func() {
		_ = os.Remove(pushChunkTempPath("device-a", chunkSession("gapoverlap", started, int64(len(raw)), hash)))
	})

	// Stage the first 3 bytes.
	resp, err := sendChunk(ctx, client, &prosav1.PushChunkRequest{
		Session:  chunkSession("gapoverlap", started, int64(len(raw)), hash),
		Offset:   0,
		RawChunk: raw[0:3],
	})
	require.NoError(t, err)
	require.True(t, resp.Msg.Accepted)

	for _, badOffset := range []int64{5 /* gap, expected 3 */, 1 /* overlap */} {
		_, err := sendChunk(ctx, client, &prosav1.PushChunkRequest{
			Session:  chunkSession("gapoverlap", started, int64(len(raw)), hash),
			Offset:   badOffset,
			RawChunk: raw[badOffset:],
			Final:    true,
		})
		require.Error(t, err, "offset %d should be rejected", badOffset)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	}
}

func TestPushChunkRejectsHashMismatchOnFinal(t *testing.T) {
	ctx := context.Background()
	client, started := newChunkTestClient(t, ctx)

	raw := []byte("abcdefgh")
	_, err := sendChunk(ctx, client, &prosav1.PushChunkRequest{
		// Declared hash does not match the bytes we send.
		Session:  chunkSession("hashmiss", started, int64(len(raw)), sha256Hex([]byte("different"))),
		Offset:   0,
		RawChunk: raw,
		Final:    true,
	})
	require.Error(t, err)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	require.Contains(t, err.Error(), "hash mismatch")
}

func TestPushChunkRejectsTruncatedRaw(t *testing.T) {
	ctx := context.Background()
	client, started := newChunkTestClient(t, ctx)

	full := []byte("abcdefghij") // 10 bytes; hash over the full content
	_, err := sendChunk(ctx, client, &prosav1.PushChunkRequest{
		Session:  chunkSession("truncated", started, int64(len(full)), sha256Hex(full)),
		Offset:   0,
		RawChunk: full[:5], // only 5 of 10 bytes, but marked final
		Final:    true,
	})
	require.Error(t, err)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	require.Contains(t, err.Error(), "size mismatch")
}

// TestSweepStalePushChunks is a pure-fs unit test (no Postgres): partials
// older than the TTL are reaped, fresh ones and unrelated files are kept.
func TestSweepStalePushChunks(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	stale := filepath.Join(dir, "prosa-push-stale.part")
	fresh := filepath.Join(dir, "prosa-push-fresh.part")
	other := filepath.Join(dir, "unrelated.txt")
	for _, p := range []string{stale, fresh, other} {
		require.NoError(t, os.WriteFile(p, []byte("x"), 0o600))
	}
	old := time.Now().Add(-2 * pushChunkStaleAfter)
	require.NoError(t, os.Chtimes(stale, old, old))

	sweepStalePushChunks(dir, time.Now())

	_, err := os.Stat(stale)
	require.True(t, os.IsNotExist(err), "stale partial should be reaped")
	_, err = os.Stat(fresh)
	require.NoError(t, err, "fresh partial should be kept")
	_, err = os.Stat(other)
	require.NoError(t, err, "non-matching file should be untouched")
}
