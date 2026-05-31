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

func HasUsage(sess session.Session) bool {
	return session.HasTokenUsage(sess.Usage)
}
