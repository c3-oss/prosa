package cli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/session"
)

// fakeSessionsClient implements just enough of the SessionsService client
// for the reconcile tests: Manifest returns a canned response keyed by
// AfterId, and Push records every call so the test can assert which
// sessions were sent. The other RPCs are left unimplemented.
type fakeSessionsClient struct {
	// manifestPages maps after_id ("" for first page) → response.
	manifestPages map[string]*prosav1.ManifestResponse
	manifestErr   error
	pushed        []*prosav1.PushRequest
	pushErr       error
	pushSkippedID map[string]bool // sessions for which Push returns Skipped=true
}

func (f *fakeSessionsClient) Push(_ context.Context, req *connect.Request[prosav1.PushRequest]) (*connect.Response[prosav1.PushResponse], error) {
	if f.pushErr != nil {
		return nil, f.pushErr
	}
	f.pushed = append(f.pushed, req.Msg)
	skipped := req.Msg.Session != nil && f.pushSkippedID[req.Msg.Session.Id]
	return connect.NewResponse(&prosav1.PushResponse{Skipped: skipped}), nil
}

func (f *fakeSessionsClient) List(_ context.Context, _ *connect.Request[prosav1.ListRequest]) (*connect.Response[prosav1.ListResponse], error) {
	return nil, errors.New("not implemented")
}

func (f *fakeSessionsClient) Get(_ context.Context, _ *connect.Request[prosav1.GetRequest]) (*connect.Response[prosav1.GetResponse], error) {
	return nil, errors.New("not implemented")
}

func (f *fakeSessionsClient) Search(_ context.Context, _ *connect.Request[prosav1.SearchRequest]) (*connect.Response[prosav1.SearchResponse], error) {
	return nil, errors.New("not implemented")
}

func (f *fakeSessionsClient) Manifest(_ context.Context, req *connect.Request[prosav1.ManifestRequest]) (*connect.Response[prosav1.ManifestResponse], error) {
	if f.manifestErr != nil {
		return nil, f.manifestErr
	}
	resp, ok := f.manifestPages[req.Msg.AfterId]
	if !ok {
		// Page that wasn't programmed → treat as empty (end of stream).
		return connect.NewResponse(&prosav1.ManifestResponse{}), nil
	}
	return connect.NewResponse(resp), nil
}

// reconcileFixture wires a tempdir store, a fake client, and writes raw
// JSONL files on disk so pushSession can read them back.
type reconcileFixture struct {
	dir    string
	store  *store.Store
	fake   *fakeSessionsClient
	pusher *pusher
}

func newReconcileFixture(t *testing.T, deviceID string) *reconcileFixture {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	s, err := store.Open(ctx, filepath.Join(dir, "store.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })

	require.NoError(t, s.UpsertDevice(ctx, store.Device{
		ID:              deviceID,
		Hostname:        "host",
		MachineID:       "m",
		FriendlyName:    "fixture",
		FingerprintedAt: time.Now().UTC(),
	}))

	fake := &fakeSessionsClient{
		manifestPages: map[string]*prosav1.ManifestResponse{},
		pushSkippedID: map[string]bool{},
	}
	return &reconcileFixture{
		dir:    dir,
		store:  s,
		fake:   fake,
		pusher: &pusher{client: fake, store: s},
	}
}

// addSession writes a session row with a real raw file on disk. The hash
// is the test-friendly "h-<id>" mirror used by the manifest tests.
func (f *reconcileFixture) addSession(t *testing.T, ctx context.Context, deviceID, id string) {
	t.Helper()
	rawPath := filepath.Join(f.dir, id+".jsonl")
	require.NoError(t, os.WriteFile(rawPath, []byte("raw-"+id), 0o644))
	sess := session.Session{
		ID:             id,
		Agent:          "claude-code",
		DeviceID:       deviceID,
		StartedAt:      time.Now().UTC(),
		LastActivityAt: time.Now().UTC(),
		RawPath:        rawPath,
		RawHash:        "h-" + id,
		RawSize:        int64(len("raw-" + id)),
	}
	require.NoError(t, f.store.UpsertSession(ctx, sess, nil))
}

// addSessionMissingRaw is like addSession but skips writing the raw to
// disk, so the catch-up phase hits the "raw missing" error path.
func (f *reconcileFixture) addSessionMissingRaw(t *testing.T, ctx context.Context, deviceID, id string) {
	t.Helper()
	sess := session.Session{
		ID:             id,
		Agent:          "claude-code",
		DeviceID:       deviceID,
		StartedAt:      time.Now().UTC(),
		LastActivityAt: time.Now().UTC(),
		RawPath:        filepath.Join(f.dir, "ghost", id+".jsonl"), // does not exist
		RawHash:        "h-" + id,
		RawSize:        0,
	}
	require.NoError(t, f.store.UpsertSession(ctx, sess, nil))
}

func TestReconcileMissingPushed(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	fx.addSession(t, ctx, "dev", "s1")
	fx.addSession(t, ctx, "dev", "s2")

	// Server has nothing → both should be pushed.
	fx.fake.manifestPages[""] = &prosav1.ManifestResponse{}

	counts, err := reconcileWithServer(ctx, fx.pusher, "dev", nil)
	require.NoError(t, err)
	require.Equal(t, 2, counts.sent)
	require.Equal(t, 0, counts.skipped)
	require.Equal(t, 0, counts.errs)
	require.Equal(t, 2, counts.localTotal)
	require.Equal(t, 0, counts.remoteTotal)
	require.Len(t, fx.fake.pushed, 2)
}

func TestReconcileDivergentPushed(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	fx.addSession(t, ctx, "dev", "s1") // hash h-s1
	fx.addSession(t, ctx, "dev", "s2") // hash h-s2

	// Server has s1 with a stale hash, s2 with the same hash.
	fx.fake.manifestPages[""] = &prosav1.ManifestResponse{
		Entries: []*prosav1.ManifestEntry{
			{Id: "s1", RawHash: "stale", LastSyncedAt: timestamppb.Now()},
			{Id: "s2", RawHash: "h-s2", LastSyncedAt: timestamppb.Now()},
		},
	}

	counts, err := reconcileWithServer(ctx, fx.pusher, "dev", nil)
	require.NoError(t, err)
	require.Equal(t, 1, counts.sent) // only s1 re-pushed
	require.Equal(t, 0, counts.skipped)
	require.Equal(t, 0, counts.errs)
	require.Equal(t, 2, counts.localTotal)
	require.Equal(t, 2, counts.remoteTotal)
	require.Len(t, fx.fake.pushed, 1)
	require.Equal(t, "s1", fx.fake.pushed[0].Session.Id)
}

func TestReconcileConverged(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	fx.addSession(t, ctx, "dev", "s1")
	fx.addSession(t, ctx, "dev", "s2")

	// Server already has both with matching hashes → zero pushes.
	fx.fake.manifestPages[""] = &prosav1.ManifestResponse{
		Entries: []*prosav1.ManifestEntry{
			{Id: "s1", RawHash: "h-s1", LastSyncedAt: timestamppb.Now()},
			{Id: "s2", RawHash: "h-s2", LastSyncedAt: timestamppb.Now()},
		},
	}

	counts, err := reconcileWithServer(ctx, fx.pusher, "dev", nil)
	require.NoError(t, err)
	require.Equal(t, 0, counts.sent)
	require.Equal(t, 0, counts.skipped)
	require.Equal(t, 0, counts.errs)
	require.Empty(t, fx.fake.pushed)
}

func TestReconcileRawMissingCountsAsError(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	fx.addSessionMissingRaw(t, ctx, "dev", "ghost-1")
	fx.addSession(t, ctx, "dev", "live-1")

	fx.fake.manifestPages[""] = &prosav1.ManifestResponse{} // server has nothing

	counts, err := reconcileWithServer(ctx, fx.pusher, "dev", nil)
	require.NoError(t, err) // reconcile itself succeeds; per-session error tallied below
	require.Equal(t, 1, counts.sent)
	require.Equal(t, 1, counts.errs)
	require.Equal(t, 2, counts.localTotal)
	// Only the live one made it to the wire.
	require.Len(t, fx.fake.pushed, 1)
	require.Equal(t, "live-1", fx.fake.pushed[0].Session.Id)
}

func TestReconcilePaginatesManifest(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	for _, id := range []string{"s1", "s2", "s3", "s4"} {
		fx.addSession(t, ctx, "dev", id)
	}

	// Two-page manifest: server already has s1+s2 on page 1, s3 on
	// page 2 with a divergent hash; s4 is absent entirely → should push.
	fx.fake.manifestPages[""] = &prosav1.ManifestResponse{
		Entries: []*prosav1.ManifestEntry{
			{Id: "s1", RawHash: "h-s1", LastSyncedAt: timestamppb.Now()},
			{Id: "s2", RawHash: "h-s2", LastSyncedAt: timestamppb.Now()},
		},
		NextAfterId: "s2",
	}
	fx.fake.manifestPages["s2"] = &prosav1.ManifestResponse{
		Entries: []*prosav1.ManifestEntry{
			{Id: "s3", RawHash: "stale", LastSyncedAt: timestamppb.Now()},
		},
		// Empty NextAfterId — end of stream.
	}

	counts, err := reconcileWithServer(ctx, fx.pusher, "dev", nil)
	require.NoError(t, err)
	require.Equal(t, 2, counts.sent) // s3 (divergent) + s4 (missing)
	require.Equal(t, 4, counts.localTotal)
	require.Equal(t, 3, counts.remoteTotal)

	pushedIDs := make(map[string]bool, len(fx.fake.pushed))
	for _, req := range fx.fake.pushed {
		pushedIDs[req.Session.Id] = true
	}
	require.True(t, pushedIDs["s3"])
	require.True(t, pushedIDs["s4"])
}

func TestReconcileNilPusherNoOp(t *testing.T) {
	counts, err := reconcileWithServer(context.Background(), nil, "dev", nil)
	require.NoError(t, err)
	require.Equal(t, reconcileCounts{}, counts)
}

func TestReconcileProgressCallback(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	fx.addSession(t, ctx, "dev", "s1")
	fx.addSession(t, ctx, "dev", "s2")
	fx.fake.manifestPages[""] = &prosav1.ManifestResponse{}

	type tick struct{ done, total int }
	var ticks []tick
	_, err := reconcileWithServer(ctx, fx.pusher, "dev", func(done, total int) {
		ticks = append(ticks, tick{done, total})
	})
	require.NoError(t, err)
	require.Equal(t, []tick{{1, 2}, {2, 2}}, ticks)
}
