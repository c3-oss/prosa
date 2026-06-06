package antigravity

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protowire"

	_ "modernc.org/sqlite"

	"github.com/c3-oss/prosa/internal/importers/importertest"
	"github.com/c3-oss/prosa/pkg/importer"
	"github.com/c3-oss/prosa/pkg/session"
)

const (
	fixtureCascadeID       = "11111111-2222-3333-4444-555555555555"
	fixtureWorkspace       = "/tmp/antigravity-fixture-workspace"
	fixtureFirstPromptText = "olá mundo"
)

func newSink() *importertest.Sink {
	return importertest.NewSink()
}

// buildTimestampMeta produces a steps.metadata blob whose Timestamp #1
// (top-level field 1) holds the given seconds value.
func buildTimestampMeta(seconds int64) []byte {
	var ts []byte
	ts = protowire.AppendTag(ts, 1, protowire.VarintType)
	ts = protowire.AppendVarint(ts, uint64(seconds))

	var meta []byte
	meta = protowire.AppendTag(meta, 1, protowire.BytesType)
	meta = protowire.AppendBytes(meta, ts)
	return meta
}

// buildUserPromptPayload mirrors the step_type=14 layout: payload field
// 19 contains a sub-message whose field 2 carries the user prompt text.
func buildUserPromptPayload(text string) []byte {
	var inner []byte
	inner = protowire.AppendTag(inner, 2, protowire.BytesType)
	inner = protowire.AppendBytes(inner, []byte(text))

	var payload []byte
	payload = protowire.AppendTag(payload, 19, protowire.BytesType)
	payload = protowire.AppendBytes(payload, inner)
	return payload
}

// buildToolCallPayload mirrors a tool-call step: the payload embeds a
// sub-message holding the bareword tool name followed by a JSON-args
// string.
func buildToolCallPayload(name, args string) []byte {
	var inner []byte
	inner = protowire.AppendTag(inner, 1, protowire.BytesType)
	inner = protowire.AppendBytes(inner, []byte(name))
	inner = protowire.AppendTag(inner, 2, protowire.BytesType)
	inner = protowire.AppendBytes(inner, []byte(args))

	var payload []byte
	payload = protowire.AppendTag(payload, 7, protowire.BytesType)
	payload = protowire.AppendBytes(payload, inner)
	return payload
}

// buildWorkspaceBlob places the workspace file:// URL as a top-level
// string field in the trajectory_metadata_blob.data layout.
func buildWorkspaceBlob(workspace string) []byte {
	var buf []byte
	buf = protowire.AppendTag(buf, 1, protowire.BytesType)
	buf = protowire.AppendBytes(buf, []byte("file://"+workspace))
	return buf
}

// makeAntigravityFixture writes a synthetic .db that mirrors the
// antigravity-cli schema closely enough to exercise the importer
// end-to-end. The fixture is regenerated per test to keep the on-disk
// repo free of binary artifacts and to avoid leaking user-private repo
// paths from the maintainer's real conversations.
func makeAntigravityFixture(t *testing.T, root string, baseSeconds int64) string {
	t.Helper()
	require.NoError(t, os.MkdirAll(root, 0o755))
	dbPath := filepath.Join(root, fixtureCascadeID+".db")

	dsn := "file:" + url.PathEscape(dbPath) + "?mode=rwc"
	db, err := sql.Open("sqlite", dsn)
	require.NoError(t, err)
	defer func() { _ = db.Close() }()

	schema := []string{
		`CREATE TABLE trajectory_meta (
			trajectory_id text, cascade_id text,
			trajectory_type integer, source integer,
			PRIMARY KEY (trajectory_id)
		)`,
		`CREATE TABLE trajectory_metadata_blob (
			id text DEFAULT "main", data blob,
			PRIMARY KEY (id)
		)`,
		`CREATE TABLE steps (
			idx integer, step_type integer NOT NULL DEFAULT 0,
			status integer NOT NULL DEFAULT 0,
			has_subtrajectory numeric NOT NULL DEFAULT false,
			metadata blob, error_details blob, permissions blob,
			task_details blob, render_info blob, step_payload blob,
			step_format integer NOT NULL DEFAULT 0,
			PRIMARY KEY (idx)
		)`,
		`CREATE TABLE gen_metadata (
			idx integer, data blob, size integer NOT NULL DEFAULT 0,
			PRIMARY KEY (idx)
		)`,
	}
	for _, stmt := range schema {
		_, err := db.Exec(stmt)
		require.NoError(t, err, "create schema: %s", stmt)
	}

	_, err = db.Exec(
		`INSERT INTO trajectory_meta(trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)`,
		"aaaa1111-bbbb-2222-cccc-333344445555", fixtureCascadeID, 4, 17,
	)
	require.NoError(t, err)

	_, err = db.Exec(
		`INSERT INTO trajectory_metadata_blob(id, data) VALUES (?, ?)`,
		"main", buildWorkspaceBlob(fixtureWorkspace),
	)
	require.NoError(t, err)

	steps := []struct {
		idx     int
		typ     int
		offset  int64
		meta    []byte
		payload []byte
	}{
		{0, stepTypeUserInput, 0, buildTimestampMeta(baseSeconds + 0), buildUserPromptPayload(fixtureFirstPromptText)},
		{1, stepTypePlannerResponse, 1, buildTimestampMeta(baseSeconds + 1), nil},
		{
			2, 8, 2, buildTimestampMeta(baseSeconds + 2),
			buildToolCallPayload("view_file", `{"AbsolutePath":"/tmp/x/AGENTS.md","toolAction":"Viewing AGENTS.md"}`),
		},
		{3, stepTypePlannerResponse, 3, buildTimestampMeta(baseSeconds + 3), nil},
		{
			4, 21, 4, buildTimestampMeta(baseSeconds + 4),
			buildToolCallPayload("run_command", `{"CommandLine":"echo hi","Cwd":"/tmp/x","toolAction":"Running echo"}`),
		},
		{
			5, 132, 5, buildTimestampMeta(baseSeconds + 5),
			buildToolCallPayload("list_permissions", `{"toolAction":"Listing active permissions"}`),
		},
		{6, stepTypeCheckpoint, 6, buildTimestampMeta(baseSeconds + 6), nil},
	}
	for _, s := range steps {
		_, err := db.Exec(
			`INSERT INTO steps(idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)`,
			s.idx, s.typ, 3, s.meta, s.payload,
		)
		require.NoError(t, err, "insert step idx=%d", s.idx)
	}

	for i := 0; i < 3; i++ {
		_, err := db.Exec(
			`INSERT INTO gen_metadata(idx, data, size) VALUES (?, ?, ?)`,
			i, []byte{0x12, 0x02, 0x08, 0x01}, 100*(i+1),
		)
		require.NoError(t, err)
	}

	return dbPath
}

func TestImportAntigravityFixture(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	root := filepath.Join(t.TempDir(), "agy-root")
	src := makeAntigravityFixture(t, root, 1780421834)

	sink := newSink()
	imp := New()
	res, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.Equal(t, fixtureCascadeID, res.SessionID)
	require.FileExists(t, res.RawPath)
	require.Equal(t, ".db", filepath.Ext(res.RawPath))

	s := sink.Sessions[fixtureCascadeID]
	require.Equal(t, Name, s.Agent)
	require.NotEmpty(t, s.DeviceID)
	require.NotEqual(t, "local", s.DeviceID)

	require.NotNil(t, s.ProjectPath)
	require.Equal(t, fixtureWorkspace, *s.ProjectPath)
	require.Nil(t, s.Model, "antigravity model id is opaque; MVP leaves Model nil")
	require.Nil(t, s.Usage, "gen_metadata semantics unverified; MVP leaves Usage nil")

	require.NotNil(t, s.FirstPrompt)
	require.Equal(t, fixtureFirstPromptText, *s.FirstPrompt)

	require.Equal(t, time.Unix(1780421834, 0).UTC(), s.StartedAt)
	require.Equal(t, time.Unix(1780421834+6, 0).UTC(), s.LastActivityAt)

	tools := sink.Tools[fixtureCascadeID]
	require.Len(t, tools, 3)
	byName := map[string]int{}
	for _, tl := range tools {
		byName[tl.Name] = tl.Count
	}
	require.Equal(t, 1, byName["view_file"])
	require.Equal(t, 1, byName["run_command"])
	require.Equal(t, 1, byName["list_permissions"])

	turns := sink.Turns[fixtureCascadeID]
	require.Len(t, turns, 4) // 1 user + 3 tool turns; boundaries skipped.
	require.Equal(t, "user", turns[0].Role)
	require.Equal(t, fixtureFirstPromptText, turns[0].Content)
	require.Equal(t, session.KindMessage, turns[0].Kind)

	require.Equal(t, "tool", turns[1].Role)
	require.Equal(t, "view_file", turns[1].ToolName)
	require.Equal(t, session.KindToolResult, turns[1].Kind)

	res2, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.True(t, res2.Skipped, "second import of unchanged .db must be a no-op")
}

func TestImportAntigravityRespectsOverwrite(t *testing.T) {
	ctx := context.Background()
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	src := makeAntigravityFixture(t, filepath.Join(t.TempDir(), "agy-root"), 1780421834)
	sink := newSink()
	imp := New()

	res, err := imp.Import(ctx, src, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)

	res2, err := imp.Import(ctx, src, sink, importer.ImportOptions{Overwrite: true})
	require.NoError(t, err)
	require.False(t, res2.Skipped, "Overwrite must bypass the hash idempotency check")
}

func TestWalkAntigravityFindsDB(t *testing.T) {
	t.Parallel()
	root := filepath.Join(t.TempDir(), "agy-root")
	src := makeAntigravityFixture(t, root, 1780421834)
	require.NoError(t, os.WriteFile(filepath.Join(root, "decoy.txt"), []byte("not a db"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "empty.db"), []byte{}, 0o644))

	imp := New()
	got, err := imp.Walk(context.Background(), root)
	require.NoError(t, err)
	require.Equal(t, []string{src}, got)
}

func TestWalkAntigravityMissingRootReturnsEmpty(t *testing.T) {
	t.Parallel()
	imp := New()
	got, err := imp.Walk(context.Background(), filepath.Join(t.TempDir(), "nope"))
	require.NoError(t, err)
	require.Empty(t, got)
}
