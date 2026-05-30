package store

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func TestOpenReadOnlyMissingPath(t *testing.T) {
	ctx := context.Background()
	missing := filepath.Join(t.TempDir(), "absent.db")
	_, err := OpenReadOnly(ctx, missing)
	require.ErrorIs(t, err, ErrStoreNotInitialized)
}

func TestOpenReadOnlyReadsWriterDatabase(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "store.db")

	w, err := Open(ctx, path)
	require.NoError(t, err)
	require.NoError(t, w.Close())

	r, err := OpenReadOnly(ctx, path)
	require.NoError(t, err)
	t.Cleanup(func() { _ = r.Close() })

	sessions, err := r.ListSessions(ctx, SessionFilter{
		Since: time.Time{},
		Until: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	require.Empty(t, sessions)
}

func TestOpenReadOnlyConcurrentReaders(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "store.db")

	w, err := Open(ctx, path)
	require.NoError(t, err)
	require.NoError(t, seedSession(ctx, w, "sess-1", "Bash error: something failed"))
	require.NoError(t, seedSession(ctx, w, "sess-2", "exec_command returned 0"))
	require.NoError(t, w.Close())

	since := time.Now().Add(-time.Hour)
	until := time.Now().Add(time.Hour)

	var wg sync.WaitGroup
	errs := make(chan error, 24)
	for i := 0; i < 8; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			r, err := OpenReadOnly(ctx, path)
			if err != nil {
				errs <- err
				return
			}
			defer func() { _ = r.Close() }()
			if _, err := r.ListSessions(ctx, SessionFilter{Since: since, Until: until}); err != nil {
				errs <- err
			}
		}()
		go func() {
			defer wg.Done()
			r, err := OpenReadOnly(ctx, path)
			if err != nil {
				errs <- err
				return
			}
			defer func() { _ = r.Close() }()
			if _, err := r.Search(ctx, "error", SessionFilter{Since: since, Until: until}, 10); err != nil {
				errs <- err
			}
		}()
		go func() {
			defer wg.Done()
			r, err := OpenReadOnly(ctx, path)
			if err != nil {
				errs <- err
				return
			}
			defer func() { _ = r.Close() }()
			if _, err := r.GetSession(ctx, "sess-1"); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)

	var collected []error
	for e := range errs {
		collected = append(collected, e)
	}
	require.Empty(t, collected, "no goroutine should fail; got %v", collected)
}

func seedSession(ctx context.Context, s *Store, id, content string) error {
	now := time.Now().UTC()
	device := "local"
	sess := session.Session{
		ID:             id,
		Agent:          "test-agent",
		DeviceID:       device,
		StartedAt:      now,
		LastActivityAt: now,
		RawPath:        "/dev/null",
		RawHash:        "deadbeef-" + id,
		RawSize:        0,
	}
	if err := s.UpsertSession(ctx, sess, nil); err != nil {
		return err
	}
	turns := []session.Turn{
		{Role: "user", Content: content, Timestamp: now},
	}
	return s.InsertTurns(ctx, id, turns)
}

func TestOpenReadOnlyOnlyReturnsConfiguredErrors(t *testing.T) {
	require.True(t, errors.Is(ErrStoreNotInitialized, ErrStoreNotInitialized))
	require.True(t, errors.Is(ErrStoreNeedsMigration, ErrStoreNeedsMigration))
}
