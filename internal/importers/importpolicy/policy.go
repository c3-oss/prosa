package importpolicy

import (
	"context"

	"github.com/c3-oss/prosa/pkg/importer"
	"github.com/c3-oss/prosa/pkg/session"
)

func PreviouslySkippedNoUsage(ctx context.Context, sink importer.Sink, sessionID, hash string, size int64) (importer.ImportResult, bool, error) {
	skipped, err := importer.PreviouslySkipped(ctx, sink, sessionID, hash, importer.SkipReasonNoUsage)
	if err != nil || !skipped {
		return importer.ImportResult{}, false, err
	}
	return ImportSkippedNoUsageResult(sessionID, hash, size), true, nil
}

func RecordNoUsageSkip(ctx context.Context, sink importer.Sink, sessionID, hash string, size int64) (importer.ImportResult, error) {
	if err := importer.RecordSkip(ctx, sink, sessionID, hash, importer.SkipReasonNoUsage); err != nil {
		return importer.ImportResult{}, err
	}
	return ImportSkippedNoUsageResult(sessionID, hash, size), nil
}

func ImportSkippedNoUsageResult(sessionID, hash string, size int64) importer.ImportResult {
	return importer.ImportResult{
		SessionID:  sessionID,
		RawHash:    hash,
		RawSize:    size,
		Skipped:    true,
		SkipReason: importer.SkipReasonNoUsage,
	}
}

// ImportDecision tells an importer how to handle a parsed session given
// the parser's UsageState observation.
type ImportDecision int

const (
	// DecisionAdmit imports the session normally.
	DecisionAdmit ImportDecision = iota
	// DecisionSkipNoUsage records a no_usage skip and returns the cached
	// skip result without copying raw or writing rows.
	DecisionSkipNoUsage
)

// ClassifyForImport maps a UsageState onto an import decision.
// UsageStateUnknown admits (not skips) because it covers cursor sessions
// (no usage signal by design), older transcripts predating the token_count
// event, and partial sessions that never reached a usage-bearing record.
func ClassifyForImport(state session.UsageState) ImportDecision {
	if state == session.UsageStateExplicitZero {
		return DecisionSkipNoUsage
	}
	return DecisionAdmit
}
