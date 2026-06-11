package importerutil

import (
	"context"
	"fmt"
	"time"

	"github.com/c3-oss/prosa/internal/device"
	"github.com/c3-oss/prosa/internal/importers/importpolicy"
	"github.com/c3-oss/prosa/internal/projectid"
	"github.com/c3-oss/prosa/pkg/importer"
	"github.com/c3-oss/prosa/pkg/session"
)

type HashFunc func(path string) (hash string, size int64, err error)

type PeekIDFunc func(path string) (string, error)

type ParseFunc func(ctx context.Context, path string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error)

type PreserveRawFunc func(srcPath, sessionID string, startedAt time.Time) (string, error)

type SingleFileConfig struct {
	Agent string
	Path  string
	Sink  importer.Sink
	Opts  importer.ImportOptions

	Hash        HashFunc
	PeekID      PeekIDFunc
	Parse       ParseFunc
	PreserveRaw PreserveRawFunc

	// UseParsedSessionID uses sess.ID from Parse instead of the peeked ID for
	// the raw path and result; allows parsers that refine the session ID.
	UseParsedSessionID bool
}

func RunSingleFile(ctx context.Context, cfg SingleFileConfig) (importer.ImportResult, error) {
	hash, size, err := cfg.Hash(cfg.Path)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("hash %s: %w", cfg.Path, err)
	}

	peekID, err := cfg.PeekID(cfg.Path)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("peek session id %s: %w", cfg.Path, err)
	}

	if !cfg.Opts.Overwrite {
		if prev, found, err := cfg.Sink.LastHash(ctx, peekID); err == nil && found && prev == hash {
			return importer.ImportResult{
				SessionID: peekID,
				RawHash:   hash,
				RawSize:   size,
				Skipped:   true,
			}, nil
		}
		if res, ok, err := importpolicy.PreviouslySkippedNoUsage(ctx, cfg.Sink, peekID, hash, size); err != nil {
			return importer.ImportResult{}, fmt.Errorf("read import skip %s: %w", peekID, err)
		} else if ok {
			return res, nil
		}
	}

	sess, turns, tools, usageState, err := cfg.Parse(ctx, cfg.Path)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("parse %s: %w", cfg.Path, err)
	}
	if sess.ID == "" {
		sess.ID = peekID
	}
	sess.Agent = cfg.Agent
	sess.DeviceID = device.IDOnce()
	sess.RawHash = hash
	sess.RawSize = size

	writeID := peekID
	if cfg.UseParsedSessionID {
		writeID = sess.ID
	}
	if importpolicy.ClassifyForImport(usageState) == importpolicy.DecisionSkipNoUsage {
		return importpolicy.RecordNoUsageSkip(ctx, cfg.Sink, writeID, hash, size)
	}

	rawPath, err := cfg.PreserveRaw(cfg.Path, writeID, sess.StartedAt)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("preserve raw %s: %w", cfg.Path, err)
	}
	sess.RawPath = rawPath
	projectid.Apply(&sess)

	if err := cfg.Sink.WriteSession(ctx, sess, tools, turns, hash); err != nil {
		return importer.ImportResult{}, fmt.Errorf("write session %s: %w", writeID, err)
	}

	return importer.ImportResult{
		SessionID: writeID,
		RawPath:   rawPath,
		RawHash:   hash,
		RawSize:   size,
		Skipped:   false,
	}, nil
}
