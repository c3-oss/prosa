package importerutil

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/rawlock"
	"github.com/c3-oss/prosa/pkg/importer"
	"github.com/c3-oss/prosa/pkg/session"
)

type fakeSink struct {
	lastHash map[string]string
	skips    map[string]string

	wroteSession session.Session
	wroteTools   []session.ToolUsage
	wroteTurns   []session.Turn
	wroteHash    string
	writeCount   int
}

func (s *fakeSink) WriteSession(_ context.Context, sess session.Session, tools []session.ToolUsage, turns []session.Turn, hash string) error {
	s.wroteSession = sess
	s.wroteTools = tools
	s.wroteTurns = turns
	s.wroteHash = hash
	s.writeCount++
	return nil
}

func (s *fakeSink) LastHash(_ context.Context, sessionID string) (string, bool, error) {
	hash, ok := s.lastHash[sessionID]
	return hash, ok, nil
}

func (s *fakeSink) LastImportSkip(_ context.Context, sessionID, reason string) (string, bool, error) {
	hash, ok := s.skips[sessionID+"|"+reason]
	return hash, ok, nil
}

func (s *fakeSink) RecordImportSkip(_ context.Context, sessionID, hash, reason string) error {
	if s.skips == nil {
		s.skips = map[string]string{}
	}
	s.skips[sessionID+"|"+reason] = hash
	return nil
}

func TestRunSingleFileSkipsMatchingHash(t *testing.T) {
	sink := &fakeSink{lastHash: map[string]string{"peek": "hash-a"}}
	parseCalls := 0

	got, err := RunSingleFile(context.Background(), SingleFileConfig{
		Agent: "agent",
		Path:  "/tmp/source.jsonl",
		Sink:  sink,
		Hash: func(string) (string, int64, error) {
			return "hash-a", 42, nil
		},
		PeekID: func(string) (string, error) {
			return "peek", nil
		},
		Parse: func(context.Context, string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error) {
			parseCalls++
			return session.Session{}, nil, nil, session.UsageStatePresent, nil
		},
		PreserveRaw: func(string, string, time.Time) (string, error) {
			t.Fatal("preserve raw should not run on hash skip")
			return "", nil
		},
	})

	require.NoError(t, err)
	require.True(t, got.Skipped)
	require.Equal(t, "peek", got.SessionID)
	require.Equal(t, "hash-a", got.RawHash)
	require.Equal(t, int64(42), got.RawSize)
	require.Zero(t, parseCalls)
	require.Zero(t, sink.writeCount)
}

func TestRunSingleFileWritesProjection(t *testing.T) {
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	started := time.Date(2026, 6, 6, 12, 0, 0, 0, time.UTC)
	sink := &fakeSink{}

	got, err := RunSingleFile(context.Background(), SingleFileConfig{
		Agent: "agent",
		Path:  "/tmp/source.jsonl",
		Sink:  sink,
		Hash: func(string) (string, int64, error) {
			return "hash-b", 99, nil
		},
		PeekID: func(string) (string, error) {
			return "peek", nil
		},
		Parse: func(context.Context, string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error) {
			return session.Session{StartedAt: started},
				[]session.Turn{{Role: "user", Content: "hello", Timestamp: started}},
				[]session.ToolUsage{{Name: "Read", Count: 1}},
				session.UsageStatePresent,
				nil
		},
		PreserveRaw: func(srcPath, sessionID string, gotStarted time.Time) (string, error) {
			require.Equal(t, "/tmp/source.jsonl", srcPath)
			require.Equal(t, "peek", sessionID)
			require.Equal(t, started, gotStarted)
			return "/raw/peek.jsonl", nil
		},
	})

	require.NoError(t, err)
	require.False(t, got.Skipped)
	require.Equal(t, importer.ImportResult{
		SessionID: "peek",
		RawPath:   "/raw/peek.jsonl",
		RawHash:   "hash-b",
		RawSize:   99,
	}, got)
	require.Equal(t, 1, sink.writeCount)
	require.Equal(t, "peek", sink.wroteSession.ID)
	require.Equal(t, "agent", sink.wroteSession.Agent)
	require.NotEmpty(t, sink.wroteSession.DeviceID)
	require.Equal(t, "hash-b", sink.wroteSession.RawHash)
	require.Equal(t, int64(99), sink.wroteSession.RawSize)
	require.Equal(t, "/raw/peek.jsonl", sink.wroteSession.RawPath)
	require.Len(t, sink.wroteTurns, 1)
	require.Len(t, sink.wroteTools, 1)
	require.Equal(t, "hash-b", sink.wroteHash)
}

type blockingSink struct {
	fakeSink
	entered chan struct{}
	release chan struct{}
}

func (s *blockingSink) WriteSession(ctx context.Context, sess session.Session, tools []session.ToolUsage, turns []session.Turn, hash string) error {
	close(s.entered)
	<-s.release
	return s.fakeSink.WriteSession(ctx, sess, tools, turns, hash)
}

func TestRunSingleFileHoldsRawLockUntilWriteReturns(t *testing.T) {
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	sink := &blockingSink{
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	done := make(chan error, 1)
	go func() {
		_, err := RunSingleFile(context.Background(), SingleFileConfig{
			Agent: "agent",
			Path:  "/tmp/source.jsonl",
			Sink:  sink,
			Hash: func(string) (string, int64, error) {
				return "hash-lock", 4, nil
			},
			PeekID: func(string) (string, error) { return "peek", nil },
			Parse: func(context.Context, string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error) {
				return session.Session{}, nil, nil, session.UsageStatePresent, nil
			},
			PreserveRaw: func(string, string, time.Time) (string, error) {
				return "/raw/peek.jsonl", nil
			},
		})
		done <- err
	}()

	select {
	case <-sink.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("write did not start")
	}

	second := make(chan struct{})
	go func() {
		release, err := rawlock.Hold("peek")
		if err != nil {
			t.Errorf("hold: %v", err)
		} else {
			release()
		}
		close(second)
	}()
	select {
	case <-second:
		t.Fatal("prune-side lock was acquired while the importer was still inside WriteSession")
	case <-time.After(50 * time.Millisecond):
	}
	close(sink.release)

	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("import did not finish")
	}
	select {
	case <-second:
	case <-time.After(2 * time.Second):
		t.Fatal("lock was not released when WriteSession returned")
	}
}

func TestRunSingleFileNoUsageCanUseParsedSessionID(t *testing.T) {
	sink := &fakeSink{}

	got, err := RunSingleFile(context.Background(), SingleFileConfig{
		Agent: "agent",
		Path:  "/tmp/source.json",
		Sink:  sink,
		Hash: func(string) (string, int64, error) {
			return "hash-c", 7, nil
		},
		PeekID: func(string) (string, error) {
			return "peek", nil
		},
		Parse: func(context.Context, string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error) {
			return session.Session{ID: "parsed"}, nil, nil, session.UsageStateExplicitZero, nil
		},
		PreserveRaw: func(string, string, time.Time) (string, error) {
			t.Fatal("preserve raw should not run for no_usage skip")
			return "", nil
		},
		UseParsedSessionID: true,
	})

	require.NoError(t, err)
	require.True(t, got.Skipped)
	require.Equal(t, importer.SkipReasonNoUsage, got.SkipReason)
	require.Equal(t, "parsed", got.SessionID)
	require.Equal(t, "hash-c", sink.skips["parsed|"+importer.SkipReasonNoUsage])
	require.Zero(t, sink.writeCount)
}
