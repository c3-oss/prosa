package cli

import (
	"context"
	"fmt"
	"log/slog"
	"os"

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

// reconcileWithServer is the catch-up phase: it enumerates every local
// session for this device, asks the server for its current manifest,
// and pushes any session that's missing remotely or whose raw_hash
// diverged. Pushes are sequential (re-uses the same pusher / SQLite
// reader) and stream a "X / N" progress line so the user can see the
// catch-up moving even on a slow connection.
//
// When opts.Overwrite is true the divergence predicate degenerates to
// "always enqueue" — every local session is re-pushed regardless of
// whether the remote already has a matching hash. Used by
// `prosa sync --overwrite` to refresh a converged remote from local
// state.
//
// onProgress, when non-nil, is called once after each push attempt with
// the cumulative (sent + skipped + errs) and the total work. The caller
// uses it to repaint a status line; it is invoked from the same
// goroutine so no locking is required.
func reconcileWithServer(
	ctx context.Context,
	push *pusher,
	deviceID string,
	opts importer.ImportOptions,
	onProgress func(done, total int),
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

	if len(work) == 0 {
		slog.Info("reconcile: converged",
			"device", deviceID, "local", counts.localTotal, "remote", counts.remoteTotal)
		return counts, nil
	}

	slog.Info("reconcile: catching up",
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
			slog.Warn("reconcile push failed", "session", sid, "err", perr)
		case pushSkippedRemoteUnavailable:
			if onProgress != nil {
				onProgress(i+1, len(work))
			}
			return counts, nil
		}
		if onProgress != nil {
			onProgress(i+1, len(work))
		}
	}
	return counts, nil
}

// fetchServerManifest pages the server's Manifest RPC until exhausted,
// returning a map of session_id → raw_hash. Page size 1000 keeps the
// hop count low for typical devices (≤ 3 round-trips at 2 800 sessions).
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

// runSyncReconcile is the orchestrator wrapper called from runSync. It
// runs the reconcile phase (no-op when push is nil) and folds the
// results into the shared syncCounts so printSummary can render the
// Catch-up band.
func runSyncReconcile(ctx context.Context, push *pusher, deviceID string, counts *syncCounts, opts importer.ImportOptions) {
	if push == nil {
		return
	}
	if push.remoteUnavailable {
		counts.recordRemoteUnavailable(push)
		return
	}
	progress := func(done, total int) {
		// Emit a bounded progress line every 25 sessions (or at the
		// end). Keep each line terminated so stderr logs never attach to
		// an in-progress stdout repaint.
		if done == total || done%25 == 0 {
			fmt.Fprintf(os.Stdout, "Catch-up: %d / %d sessions reconciled\n", done, total)
		}
	}
	rc, err := reconcileWithServer(ctx, push, deviceID, opts, progress)
	if err != nil {
		if push.remoteUnavailable || isRemoteUnavailable(err) {
			counts.recordRemoteUnavailable(push)
			return
		}
		slog.Warn("reconcile failed", "err", err)
	}
	if push.remoteUnavailable {
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
