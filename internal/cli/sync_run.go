package cli

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/c3-oss/prosa/internal/cli/spinner"
	"github.com/c3-oss/prosa/pkg/importer"
)

// runSyncInteractive drives the two-phase Bubble Tea checklist (local
// import + optional remote catch-up). The driver goroutine runs
// sequentially and feeds updates into a channel the Bubble Tea program
// consumes. Reconcile runs inside the same program lifetime so the remote
// row can animate.
func runSyncInteractive(
	ctx context.Context,
	work []syncJob,
	sink importer.Sink,
	push *pusher,
	deviceID string,
	counts *syncCounts,
	opts importer.ImportOptions,
) error {
	items := make([]spinner.Item, len(work))
	for i, w := range work {
		label := w.imp.Name()
		if w.legacy {
			label = "legacy/" + label
		}
		items[i] = spinner.Item{Agent: label, Path: w.path}
	}
	updates := make(chan spinner.Update, len(work)*2+16)

	// Suppress the catch-up phase's structured logging while Bubble Tea
	// repaints in place; concurrent writes (e.g. reconcile: catching up)
	// desync the cursor and orphan frames. We scope this to the pusher's
	// logger rather than mutating the process-global slog default, which
	// would silently swallow every other component's logs for the duration.
	var suppressedWarnings atomic.Int64
	if push != nil {
		push.logger = slog.New(warningCounterHandler{count: &suppressedWarnings})
	}

	go func() {
		defer close(updates)
		send := func(u spinner.Update) bool {
			select {
			case <-ctx.Done():
				return false
			case updates <- u:
				return true
			}
		}

		if !send(spinner.Update{
			Phase: spinner.PhaseLocal,
			Begin: true,
			Total: len(work),
			Verb:  "importing",
		}) {
			return
		}

		for i, w := range work {
			if !send(spinner.Update{Phase: spinner.PhaseLocal, Index: i, Started: true}) {
				return
			}
			var res importer.ImportResult
			err := w.prepareErr
			if err == nil {
				res, err = w.imp.Import(ctx, w.path, sink, opts)
			}
			if w.prepareErr == nil && w.cleanup != nil {
				w.cleanup()
			}
			counts.record(w, res, err)
			itemErr := err
			if shouldInlinePush(push, res, err) {
				outcome, perr := push.pushSession(ctx, res.SessionID)
				counts.recordPush(outcome, perr)
				itemErr = localItemErr(err, outcome, perr)
			}
			if !send(spinner.Update{
				Phase:   spinner.PhaseLocal,
				Index:   i,
				Skipped: res.Skipped,
				Err:     itemErr,
			}) {
				return
			}
		}

		if !send(spinner.Update{Phase: spinner.PhaseLocal, Done: true, Verb: "imported"}) {
			return
		}

		if push == nil {
			return
		}

		if !send(spinner.Update{
			Phase: spinner.PhaseRemote,
			Begin: true,
			Verb:  "reconciling",
		}) {
			return
		}

		var rc reconcileCounts
		var reconcileErr error
		hooks := reconcileHooks{
			onPlan: func(total int) {
				send(spinner.Update{
					Phase:    spinner.PhaseRemote,
					SetTotal: true,
					Total:    total,
				})
			},
			onStep: func(done, total int, sid string, outcome pushOutcome, err error) {
				u := spinner.Update{
					Phase: spinner.PhaseRemote,
					Active: &spinner.Item{
						Agent: "remote",
						Path:  sid,
					},
				}
				switch outcome {
				case pushAlreadyHashed, pushSkippedNoUsage, pushSkippedRemoteUnavailable:
					u.Skipped = true
				case pushFailed:
					// Surface the server's real message; fall back to a
					// generic string if (defensively) no error came through.
					if err != nil {
						u.Err = err
					} else {
						u.Err = errors.New("push failed")
					}
				default:
					// pushImported counts as done (sent).
				}
				send(u)
			},
		}
		rc, reconcileErr = reconcileWithServer(ctx, push, deviceID, opts, hooks)
		foldReconcile(counts, rc, reconcileErr, push)

		extra := fmt.Sprintf("local %d · remote %d", rc.localTotal, rc.remoteTotal)
		if push.remoteUnavailable || isRemoteUnavailable(reconcileErr) {
			send(spinner.Update{
				Phase:       spinner.PhaseRemote,
				Done:        true,
				Unavailable: true,
				Verb:        "unavailable",
				Extra:       extra,
			})
			return
		}
		send(spinner.Update{
			Phase: spinner.PhaseRemote,
			Done:  true,
			Verb:  "sent",
			Extra: extra,
		})
	}()

	spinnerOpts := spinner.Options{
		Title:         "prosa sync · local store",
		Found:         syncFoundSummary(items),
		RemoteEnabled: push != nil,
	}
	if counts.legacyTotal > 0 {
		spinnerOpts.Banner = fmt.Sprintf("legacy bundle: %s", legacyBundleFlag)
	}
	fmt.Fprintln(os.Stdout)
	if err := spinner.Run(ctx, items, updates, spinnerOpts); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	counts.suppressedWarnings = int(suppressedWarnings.Load())
	return nil
}

func syncFoundSummary(items []spinner.Item) string {
	if len(items) == 0 {
		return ""
	}
	counts := map[string]int{}
	var order []string
	for _, item := range items {
		if _, ok := counts[item.Agent]; !ok {
			order = append(order, item.Agent)
		}
		counts[item.Agent]++
	}
	parts := make([]string, 0, len(order))
	for _, agent := range order {
		parts = append(parts, fmt.Sprintf("%s %d", agent, counts[agent]))
	}
	return strings.Join(parts, " · ")
}

// runSyncPlain is the non-TTY fallback used by LaunchAgent/cron and by
// the --verbose flag. One structured log line per session; the summary
// block is printed by the orchestrator (runSync) after the reconcile
// phase. No escape codes, no alt-screen.
func runSyncPlain(ctx context.Context, work []syncJob, sink importer.Sink, push *pusher, counts *syncCounts, opts importer.ImportOptions) error {
	for _, w := range work {
		start := time.Now()
		var res importer.ImportResult
		err := w.prepareErr
		if err == nil {
			res, err = w.imp.Import(ctx, w.path, sink, opts)
		}
		if w.prepareErr == nil && w.cleanup != nil {
			w.cleanup()
		}
		dur := time.Since(start)
		counts.record(w, res, err)
		switch {
		case err != nil:
			slog.Error("import failed",
				"agent", w.imp.Name(), "path", w.path, "legacy", w.legacy, "err", err)
		case res.Skipped:
			slog.Info("imported",
				"agent", w.imp.Name(), "session", res.SessionID, "status", "skipped",
				"legacy", w.legacy, "dur", dur)
		default:
			slog.Info("imported",
				"agent", w.imp.Name(), "session", res.SessionID, "status", "done",
				"legacy", w.legacy, "dur", dur)
			if shouldInlinePush(push, res, nil) {
				outcome, pushErr := push.pushSession(ctx, res.SessionID)
				counts.recordPush(outcome, pushErr)
				logPush(res.SessionID, outcome, pushErr)
			}
		}
	}
	return nil
}

// localItemErr decides what the interactive spinner shows on a local-phase
// row. The import error wins; otherwise, when the inline push genuinely
// failed (pushFailed — not remote-unavailable, which is a global state
// shown on the remote row), surface that push error so a healthy import
// with a failed push isn't rendered as a clean check mark (issue #74).
func localItemErr(importErr error, outcome pushOutcome, pushErr error) error {
	if importErr != nil {
		return importErr
	}
	if outcome == pushFailed {
		return pushErr
	}
	return nil
}
