package cli

import (
	"context"
	"encoding/json"
	"io"

	"github.com/c3-oss/prosa/pkg/importer"
)

// syncJSONSession is one NDJSON record emitted per session by
// `prosa sync --json`. Phase is "local" for the inline import pass and
// "catchup" for the remote reconcile pass.
type syncJSONSession struct {
	Type      string `json:"type"` // always "session"
	Phase     string `json:"phase"`
	Agent     string `json:"agent,omitempty"`
	SessionID string `json:"session_id,omitempty"`
	Status    string `json:"status,omitempty"` // imported | skipped | error
	Push      string `json:"push,omitempty"`   // sent | skipped | failed | unavailable | disabled | deferred
	Err       string `json:"err,omitempty"`
}

// syncJSONSummary is the final NDJSON record with the run tally. Counts are
// emitted even when zero so consumers get a stable shape.
type syncJSONSummary struct {
	Type           string `json:"type"` // always "summary"
	Imported       int    `json:"imported"`
	Skipped        int    `json:"skipped"`
	Errors         int    `json:"errors"`
	PushSent       int    `json:"push_sent"`
	PushSkipped    int    `json:"push_skipped"`
	PushErrors     int    `json:"push_errors"`
	CatchupSent    int    `json:"catchup_sent"`
	CatchupSkipped int    `json:"catchup_skipped"`
	CatchupErrors  int    `json:"catchup_errors"`
}

// pushStatusString maps a pushOutcome to the --json "push" field value.
func pushStatusString(outcome pushOutcome) string {
	switch outcome {
	case pushImported:
		return "sent"
	case pushAlreadyHashed, pushSkippedNoUsage:
		return "skipped"
	case pushFailed:
		return "failed"
	case pushSkippedRemoteUnavailable:
		return "unavailable"
	default:
		return ""
	}
}

// runSyncJSON is the --json sync path: one NDJSON record per session plus a
// catch-up reconcile pass. slog diagnostics go to stderr; stdout stays pure NDJSON.
func runSyncJSON(
	ctx context.Context,
	w io.Writer,
	work []syncJob,
	sink importer.Sink,
	push *pusher,
	deviceID string,
	counts *syncCounts,
	opts importer.ImportOptions,
) error {
	enc := json.NewEncoder(w)

	for _, job := range work {
		var res importer.ImportResult
		err := job.prepareErr
		if err == nil {
			jobOpts := opts
			jobOpts.Profile = job.profile
			res, err = job.imp.Import(ctx, job.path, sink, jobOpts)
		}
		if job.prepareErr == nil && job.cleanup != nil {
			job.cleanup()
		}
		counts.record(job, res, err)

		line := syncJSONSession{Type: "session", Phase: "local", Agent: job.imp.Name(), SessionID: res.SessionID}
		switch {
		case err != nil:
			line.Status = "error"
			line.Err = err.Error()
		case res.Skipped:
			line.Status = "skipped"
		default:
			line.Status = "imported"
			switch {
			case push == nil:
				line.Push = "disabled"
			case res.Synthetic:
				// Hermes state.db marker: real sessions surface in the catch-up pass.
				line.Push = "deferred"
			default:
				outcome, perr := push.pushSession(ctx, res.SessionID)
				counts.recordPush(outcome, perr)
				line.Push = pushStatusString(outcome)
				if outcome == pushFailed && perr != nil {
					line.Err = perr.Error()
				}
			}
		}
		_ = enc.Encode(line)
	}

	if push == nil {
		return nil
	}
	if push.remoteUnavailable {
		counts.recordRemoteUnavailable(push)
		return nil
	}

	hooks := reconcileHooks{
		onStep: func(_, _ int, sid string, outcome pushOutcome, perr error) {
			line := syncJSONSession{
				Type:      "session",
				Phase:     "catchup",
				Agent:     "remote",
				SessionID: sid,
				Push:      pushStatusString(outcome),
			}
			if outcome == pushFailed && perr != nil {
				line.Err = perr.Error()
			}
			_ = enc.Encode(line)
		},
	}
	rc, rerr := reconcileWithServer(ctx, push, deviceID, opts, hooks)
	foldReconcile(counts, rc, rerr, push)
	return nil
}

func emitSyncJSONSummary(w io.Writer, counts *syncCounts) {
	_ = json.NewEncoder(w).Encode(syncJSONSummary{
		Type:           "summary",
		Imported:       counts.liveImp + counts.legacyImp,
		Skipped:        counts.liveSkip + counts.legacySkip,
		Errors:         counts.liveErr + counts.legacyErr,
		PushSent:       counts.pushImp,
		PushSkipped:    counts.pushSkip,
		PushErrors:     counts.pushErr,
		CatchupSent:    counts.catchUpSent,
		CatchupSkipped: counts.catchUpSkip,
		CatchupErrors:  counts.catchUpErr,
	})
}
