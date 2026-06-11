package cli

import (
	"context"
	"fmt"
	"log/slog"

	"connectrpc.com/connect"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/pkg/importer"
	"github.com/c3-oss/prosa/pkg/session"
)

// reconcileCounts aggregates the catch-up phase results.
type reconcileCounts struct {
	sent, skipped, errs int
	localTotal          int
	remoteTotal         int
}

// reconcileHooks drives interactive progress for the catch-up phase.
// Both callbacks are optional and nil-safe.
type reconcileHooks struct {
	onPlan func(total int)
	// onStep reports one catch-up push. err carries the real push error for
	// pushFailed outcomes so the UI can surface the server's message instead
	// of a generic "push failed"; it is nil for successful/skipped outcomes.
	onStep func(done, total int, sid string, outcome pushOutcome, err error)
}

// reconcileWithServer pushes any local session missing remotely or with a
// diverged raw_hash. With opts.Overwrite every session is re-pushed regardless.
func reconcileWithServer(
	ctx context.Context,
	push *pusher,
	deviceID string,
	opts importer.ImportOptions,
	hooks reconcileHooks,
) (reconcileCounts, error) {
	var counts reconcileCounts
	if push == nil {
		return counts, nil
	}

	serverHas, err := fetchServerManifest(ctx, push)
	if err != nil {
		return counts, err
	}
	counts.remoteTotal = len(serverHas)

	local, err := push.store.ListSessionsManifest(ctx, deviceID, "", 0)
	if err != nil {
		return counts, fmt.Errorf("list local manifest: %w", err)
	}
	counts.localTotal = len(local)

	var work []string
	for _, row := range local {
		remote, ok := serverHas[row.ID]
		staleProjection := ok && remote.ProjectionVersion < session.ProjectionVersion
		if opts.Overwrite || !ok || remote.RawHash != row.RawHash || staleProjection {
			work = append(work, row.ID)
		}
	}

	if hooks.onPlan != nil {
		hooks.onPlan(len(work))
	}

	if len(work) == 0 {
		push.log().InfoContext(ctx, "reconcile: converged",
			"device", deviceID, "local", counts.localTotal, "remote", counts.remoteTotal)
		return counts, nil
	}

	push.log().InfoContext(ctx, "reconcile: catching up",
		"device", deviceID, "to_push", len(work),
		"local", counts.localTotal, "remote", counts.remoteTotal)

	for i, sid := range work {
		if ctx.Err() != nil {
			return counts, ctx.Err()
		}
		outcome, perr := push.pushSession(ctx, sid)
		switch outcome {
		case pushImported:
			counts.sent++
		case pushAlreadyHashed, pushSkippedNoUsage:
			counts.skipped++
		case pushFailed:
			counts.errs++
			push.log().WarnContext(ctx, "reconcile push failed", "session", sid, "err", perr)
		case pushSkippedRemoteUnavailable:
			if hooks.onStep != nil {
				hooks.onStep(i+1, len(work), sid, outcome, perr)
			}
			return counts, nil
		}
		if hooks.onStep != nil {
			hooks.onStep(i+1, len(work), sid, outcome, perr)
		}
	}
	return counts, nil
}

// fetchServerManifest pages the Manifest RPC (page size 1000) until exhausted.
type serverManifestRow struct {
	RawHash           string
	ProjectionVersion int
}

func fetchServerManifest(ctx context.Context, push *pusher) (map[string]serverManifestRow, error) {
	out := map[string]serverManifestRow{}
	after := ""
	for {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		resp, err := push.client.Manifest(ctx, connect.NewRequest(&prosav1.ManifestRequest{
			AfterId: after,
			Limit:   1000,
		}))
		if err != nil {
			if isRemoteUnavailable(err) {
				push.markRemoteUnavailable()
				return nil, fmt.Errorf("manifest rpc: %w", err)
			}
			return nil, fmt.Errorf("manifest rpc: %w", err)
		}
		for _, e := range resp.Msg.Entries {
			out[e.Id] = serverManifestRow{
				RawHash:           e.RawHash,
				ProjectionVersion: int(e.ProjectionVersion),
			}
		}
		if resp.Msg.NextAfterId == "" {
			return out, nil
		}
		after = resp.Msg.NextAfterId
	}
}

func foldReconcile(counts *syncCounts, rc reconcileCounts, err error, push *pusher) {
	if err != nil {
		if push != nil && (push.remoteUnavailable || isRemoteUnavailable(err)) {
			counts.recordRemoteUnavailable(push)
			return
		}
		logger := slog.Default()
		if push != nil {
			logger = push.log()
		}
		logger.Warn("reconcile failed", "err", err)
	}
	if push != nil && push.remoteUnavailable {
		counts.recordRemoteUnavailable(push)
		return
	}
	counts.catchUpSent = rc.sent
	counts.catchUpSkip = rc.skipped
	counts.catchUpErr = rc.errs
	counts.reconcileRan = true
	counts.localTotal = rc.localTotal
	counts.remoteTotal = rc.remoteTotal
}

func runSyncReconcile(ctx context.Context, push *pusher, deviceID string, counts *syncCounts, opts importer.ImportOptions) {
	if push == nil {
		return
	}
	if push.remoteUnavailable {
		counts.recordRemoteUnavailable(push)
		return
	}
	hooks := reconcileHooks{
		onStep: func(done, total int, _ string, _ pushOutcome, _ error) {
			if done == total || done%25 == 0 {
				slog.Info("reconcile progress",
					"done", done, "total", total)
			}
		},
	}
	rc, err := reconcileWithServer(ctx, push, deviceID, opts, hooks)
	foldReconcile(counts, rc, err, push)
}
