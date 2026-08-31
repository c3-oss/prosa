package cli

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/pkg/importer"
	"github.com/c3-oss/prosa/pkg/session"
)

func TestPushRecordsPushedState(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	fx.addSession(t, ctx, "dev", "s1")
	require.NoError(t, fx.store.RecordSync(ctx, "s1", "h-s1"))
	fx.fake.pushRawURI = "s3://bucket/dev/claude-code/s1.jsonl"

	outcome, err := fx.pusher.pushSession(ctx, "s1")
	require.NoError(t, err)
	require.Equal(t, pushImported, outcome)

	var pushedHash, remoteURI string
	require.NoError(t, fx.store.DB().QueryRowContext(ctx,
		`SELECT pushed_hash, remote_uri FROM sync_state WHERE session_id = 's1'`,
	).Scan(&pushedHash, &remoteURI))
	require.Equal(t, "h-s1", pushedHash)
	require.Equal(t, "s3://bucket/dev/claude-code/s1.jsonl", remoteURI)
}

func TestPushAlreadyHashedRecordsPushedState(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	fx.addSession(t, ctx, "dev", "s1")
	require.NoError(t, fx.store.RecordSync(ctx, "s1", "h-s1"))
	fx.fake.pushSkippedID["s1"] = true

	outcome, err := fx.pusher.pushSession(ctx, "s1")
	require.NoError(t, err)
	require.Equal(t, pushAlreadyHashed, outcome)

	var pushedHash string
	require.NoError(t, fx.store.DB().QueryRowContext(ctx,
		`SELECT pushed_hash FROM sync_state WHERE session_id = 's1'`,
	).Scan(&pushedHash))
	require.Equal(t, "h-s1", pushedHash)
}

func TestPushSkipsPrunedSession(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	fx.addSession(t, ctx, "dev", "s1")
	ok, err := fx.store.MarkPruned(ctx, "s1", "h-s1")
	require.NoError(t, err)
	require.True(t, ok)

	outcome, err := fx.pusher.pushSession(ctx, "s1")
	require.NoError(t, err)
	require.Equal(t, pushSkippedPruned, outcome)
	require.Zero(t, fx.fake.pushCalls)
}

func TestReconcileExcludesPrunedSessions(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	fx.addSession(t, ctx, "dev", "s1")
	fx.addSession(t, ctx, "dev", "s2")
	ok, err := fx.store.MarkPruned(ctx, "s1", "h-s1")
	require.NoError(t, err)
	require.True(t, ok)

	// Server reports s1 with a divergent hash and a stale projection —
	// normally the strongest re-push triggers. Pruned wins.
	fx.fake.manifestPages[""] = &prosav1.ManifestResponse{
		Entries: []*prosav1.ManifestEntry{
			{Id: "s1", RawHash: "stale", LastSyncedAt: timestamppb.Now(), ProjectionVersion: 1},
		},
	}

	counts, err := reconcileWithServer(ctx, fx.pusher, "dev", importer.ImportOptions{}, reconcileHooks{})
	require.NoError(t, err)
	require.Equal(t, 1, counts.sent, "only the live session is pushed")
	require.Len(t, fx.fake.pushed, 1)
	require.Equal(t, "s2", fx.fake.pushed[0].Session.Id)
}

func TestReconcileExcludesPrunedEvenWithOverwrite(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	fx.addSession(t, ctx, "dev", "s1")
	ok, err := fx.store.MarkPruned(ctx, "s1", "h-s1")
	require.NoError(t, err)
	require.True(t, ok)
	fx.fake.manifestPages[""] = &prosav1.ManifestResponse{}

	counts, err := reconcileWithServer(ctx, fx.pusher, "dev",
		importer.ImportOptions{Overwrite: true}, reconcileHooks{})
	require.NoError(t, err)
	require.Zero(t, counts.sent)
	require.Empty(t, fx.fake.pushed)
}

func TestReconcileBackfillsPushedState(t *testing.T) {
	ctx := context.Background()
	fx := newReconcileFixture(t, "dev")
	fx.addSession(t, ctx, "dev", "s1")
	require.NoError(t, fx.store.RecordSync(ctx, "s1", "h-s1"))

	// Server already converged (pushed before push state existed locally).
	fx.fake.manifestPages[""] = &prosav1.ManifestResponse{
		Entries: []*prosav1.ManifestEntry{
			{Id: "s1", RawHash: "h-s1", LastSyncedAt: timestamppb.Now(), ProjectionVersion: int32(session.ProjectionVersion)},
		},
	}

	counts, err := reconcileWithServer(ctx, fx.pusher, "dev", importer.ImportOptions{}, reconcileHooks{})
	require.NoError(t, err)
	require.Zero(t, counts.sent)

	var pushedHash string
	require.NoError(t, fx.store.DB().QueryRowContext(ctx,
		`SELECT pushed_hash FROM sync_state WHERE session_id = 's1'`,
	).Scan(&pushedHash))
	require.Equal(t, "h-s1", pushedHash)

	adv, _, err := fx.store.PruneAdvisory(ctx, "dev",
		time.Now().UTC().Add(24*time.Hour), time.Now().UTC().Add(24*time.Hour))
	require.NoError(t, err)
	require.Equal(t, 1, adv)
}
