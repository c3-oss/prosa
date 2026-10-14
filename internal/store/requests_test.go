package store

import (
	"fmt"
	"io/fs"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/migrations/local"
	"github.com/c3-oss/prosa/pkg/session"
)

func TestRequestProjectionRoundTripAndReplacement(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	at := time.Date(2026, 10, 10, 10, 0, 0, 0, time.UTC)
	zero := int64(0)
	standard := "standard"
	sess := newSession("requests", at)
	sess.RequestCoverage = session.RequestCoverageComplete
	sess.ProjectionVersion = session.ProjectionVersion - 1
	sess.Requests = []session.RequestUsage{
		{
			ID: "first", Model: "gpt-6-astra", Timestamp: &at,
			Usage:        session.TokenUsage{TotalTokens: 110, InputTokens: 100, OutputTokens: 10},
			PromptTokens: &zero, ServiceTier: &standard, CacheCreation5mTokens: &zero,
		},
		{ID: "second", Model: "claude-sonnet-5-5", Usage: session.TokenUsage{InputTokens: 200}},
	}
	turns := []session.Turn{{Role: "user", Content: "find request evidence", Timestamp: at}}
	require.NoError(t, s.WriteSession(ctx, sess, nil, turns, "requests-old"))
	got, err := s.GetSession(ctx, sess.ID)
	require.NoError(t, err)
	require.Equal(t, sess.Requests, got.Requests)
	require.Equal(t, sess.RequestCoverage, got.RequestCoverage)
	require.Equal(t, sess.ProjectionVersion, got.ProjectionVersion)

	list, err := s.ListSessions(ctx, SessionFilter{Since: at.Add(-time.Hour), Until: at.Add(time.Hour)})
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, sess.Requests, list[0].Requests)
	hits, err := s.Search(ctx, "evidence", SessionFilter{Since: at.Add(-time.Hour), Until: at.Add(time.Hour)}, 10)
	require.NoError(t, err)
	require.Len(t, hits, 1)
	require.Equal(t, sess.Requests, hits[0].Session.Requests)
	require.Equal(t, sess.ProjectionVersion, hits[0].Session.ProjectionVersion)
	manifest, err := s.ListSessionsManifest(ctx, sess.DeviceID, "", 0)
	require.NoError(t, err)
	require.Len(t, manifest, 1)
	require.Equal(t, sess.ProjectionVersion, manifest[0].ProjectionVersion)
	_, current, err := s.LastHash(ctx, sess.ID)
	require.NoError(t, err)
	require.False(t, current)

	sess.RequestCoverage = session.RequestCoveragePartial
	sess.ProjectionVersion = session.ProjectionVersion
	sess.Requests = sess.Requests[1:]
	require.NoError(t, s.WriteSession(ctx, sess, nil, turns, "requests-new"))
	got, err = s.GetSession(ctx, sess.ID)
	require.NoError(t, err)
	require.Equal(t, sess.Requests, got.Requests)
	require.Equal(t, session.RequestCoveragePartial, got.RequestCoverage)

	sess.Requests = nil
	sess.RequestCoverage = ""
	require.NoError(t, s.UpsertSession(ctx, sess, nil))
	got, err = s.GetSession(ctx, sess.ID)
	require.NoError(t, err)
	require.Empty(t, got.Requests)
	require.Equal(t, session.RequestCoverageNone, got.RequestCoverage)
}

func TestRequestMigrationRetainsLegacyProjectionVersion(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	at := time.Date(2026, 10, 10, 10, 0, 0, 0, time.UTC)
	sess := newSession("legacy-request-migration", at)
	sess.ProjectionVersion = session.ProjectionVersion - 1
	require.NoError(t, s.WriteSession(ctx, sess, nil, nil, "legacy-hash"))
	down, err := fs.ReadFile(local.FS, "0012_request_usage.down.sql")
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, string(down))
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `DELETE FROM schema_migrations WHERE version = 12`)
	require.NoError(t, err)
	require.NoError(t, s.migrate(ctx))
	got, err := s.GetSession(ctx, sess.ID)
	require.NoError(t, err)
	require.Equal(t, sess.ProjectionVersion, got.ProjectionVersion)
	require.Equal(t, session.RequestCoverageNone, got.RequestCoverage)
	require.Empty(t, got.Requests)
}

func TestRequestProjectionFailurePreservesPreviousProjection(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	at := time.Date(2026, 10, 10, 10, 0, 0, 0, time.UTC)
	sess := newSession("request-rollback", at)
	sess.RequestCoverage = session.RequestCoveragePartial
	sess.Requests = []session.RequestUsage{{ID: "original", Model: "gpt-6-astra"}}
	require.NoError(t, s.WriteSession(ctx, sess, nil, nil, "original-hash"))
	_, err := s.db.ExecContext(ctx, `CREATE TRIGGER reject_request BEFORE INSERT ON session_requests
		WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'request rejected'); END`)
	require.NoError(t, err)
	sess.RequestCoverage = session.RequestCoverageComplete
	sess.Requests = []session.RequestUsage{{ID: "replacement"}, {ID: "rejected"}}
	require.Error(t, s.WriteSession(ctx, sess, nil, nil, "replacement-hash"))
	got, err := s.GetSession(ctx, sess.ID)
	require.NoError(t, err)
	require.Equal(t, session.RequestCoveragePartial, got.RequestCoverage)
	require.Equal(t, []session.RequestUsage{{ID: "original", Model: "gpt-6-astra"}}, got.Requests)
	hash, current, err := s.LastHash(ctx, sess.ID)
	require.NoError(t, err)
	require.True(t, current)
	require.Equal(t, "original-hash", hash)
}

func TestRequestProjectionLoadsMultipleBatchesAndCascades(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	at := time.Date(2026, 10, 10, 10, 0, 0, 0, time.UTC)
	sess := newSession("request-batch", at)
	sess.Requests = []session.RequestUsage{{ID: "measured", Model: "gpt-6-astra"}}
	require.NoError(t, s.UpsertSession(ctx, sess, nil))
	list := make([]session.Session, 501)
	for i := range list {
		list[i].ID = fmt.Sprintf("absent-%d", i)
	}
	list[0].ID = sess.ID
	list[500].ID = sess.ID
	require.NoError(t, attachRequests(ctx, s.db, list))
	require.Equal(t, sess.Requests, list[0].Requests)
	require.Equal(t, sess.Requests, list[500].Requests)
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, sess.ID)
	require.NoError(t, err)
	var n int
	require.NoError(t, s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM session_requests`).Scan(&n))
	require.Zero(t, n)
}
