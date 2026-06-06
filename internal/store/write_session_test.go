package store

import (
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

// WriteSession persists the session row, its turns, its tools, and the
// sync_state hash together. See issue #81.
func TestWriteSessionPersistsWholeProjection(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	sess := newSession("ws-1", now)
	sess.Usage = &session.TokenUsage{TotalTokens: 7}
	tools := []session.ToolUsage{{Name: "Bash", Count: 2}}
	turns := []session.Turn{
		{Role: "user", Content: "hello", Timestamp: now, Kind: session.KindMessage},
		{Role: "assistant", Content: "hi", Timestamp: now, Kind: session.KindMessage},
	}

	require.NoError(t, s.WriteSession(ctx, sess, tools, turns, "hash-1"))

	got, err := s.GetSession(ctx, "ws-1")
	require.NoError(t, err)
	require.Equal(t, "ws-1", got.ID)

	gotTurns, err := s.GetTurns(ctx, "ws-1")
	require.NoError(t, err)
	require.Len(t, gotTurns, 2)

	gotTools, err := s.GetSessionTools(ctx, "ws-1")
	require.NoError(t, err)
	require.Len(t, gotTools, 1)

	hash, ok, err := s.LastHash(ctx, "ws-1")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, "hash-1", hash)
}

// A failure during the write must roll back the whole projection: no
// session row left visible without its turns or sync_state. We force the
// final step (recordSync) to fail by dropping sync_state, then assert the
// session row and its turns never landed.
func TestWriteSessionRollsBackOnFailure(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	_, err := s.db.ExecContext(ctx, `DROP TABLE sync_state`)
	require.NoError(t, err)

	sess := newSession("ws-rollback", now)
	turns := []session.Turn{{Role: "user", Content: "hello", Timestamp: now, Kind: session.KindMessage}}

	err = s.WriteSession(ctx, sess, nil, turns, "hash-x")
	require.Error(t, err, "recordSync must fail with sync_state dropped")

	_, err = s.GetSession(ctx, "ws-rollback")
	require.True(t, errors.Is(err, sql.ErrNoRows), "session row must be rolled back, got %v", err)

	gotTurns, err := s.GetTurns(ctx, "ws-rollback")
	require.NoError(t, err)
	require.Empty(t, gotTurns, "turns must be rolled back with the session")
}
