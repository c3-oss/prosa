//go:build antigravitydebug

package antigravity

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/importer"
)

// TestImportRealAntigravityDB runs the importer end-to-end against a
// real .db (path supplied via PROSA_TEST_ANTIGRAVITY_DB) and prints
// the projected session for human review. Logs the result rather than
// asserting on specifics - different real conversations expose
// different shapes.
func TestImportRealAntigravityDB(t *testing.T) {
	path := os.Getenv("PROSA_TEST_ANTIGRAVITY_DB")
	if path == "" {
		t.Skip("set PROSA_TEST_ANTIGRAVITY_DB=/path/to/conv.db to enable")
	}
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	sink := newSink()
	imp := New()
	res, err := imp.Import(context.Background(), path, sink, importer.ImportOptions{})
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.FileExists(t, res.RawPath)
	s := sink.Sessions[res.SessionID]
	t.Logf("session id:     %s", s.ID)
	t.Logf("agent:          %s", s.Agent)
	if s.ProjectPath != nil {
		t.Logf("project path:   %s", *s.ProjectPath)
	}
	if s.ProjectRemote != nil {
		t.Logf("project remote: %s", *s.ProjectRemote)
	}
	t.Logf("started at:     %s", s.StartedAt)
	t.Logf("last activity:  %s", s.LastActivityAt)
	if s.FirstPrompt != nil {
		t.Logf("first prompt:   %q", *s.FirstPrompt)
	}
	if s.Model != nil {
		t.Logf("model:          %s", *s.Model)
	}
	if s.Usage != nil {
		t.Logf("usage:          total=%d input=%d output=%d cached=%d",
			s.Usage.TotalTokens, s.Usage.InputTokens, s.Usage.OutputTokens, s.Usage.CachedTokens)
	}
	t.Logf("turns:          %d", len(sink.Turns[s.ID]))
	for _, tl := range sink.Tools[s.ID] {
		t.Logf("tool:           %s x %d", tl.Name, tl.Count)
	}
}

// TestDebugGenMetadataSnapshot loads a real antigravity .db (path
// supplied via PROSA_TEST_ANTIGRAVITY_DB) and logs the gen_metadata
// rows. Never asserts - the only goal is to give the maintainer a
// printable trace for confirming or upgrading the token-usage decoder
// in parse.go::readUsage.
func TestDebugGenMetadataSnapshot(t *testing.T) {
	t.Parallel()
	path := os.Getenv("PROSA_TEST_ANTIGRAVITY_DB")
	if path == "" {
		t.Skip("set PROSA_TEST_ANTIGRAVITY_DB=/path/to/conv.db to enable")
	}
	db, err := openReadOnly(path)
	require.NoError(t, err)
	defer func() { _ = db.Close() }()

	rows, err := db.Query(`SELECT idx, size, length(data) FROM gen_metadata ORDER BY idx`)
	require.NoError(t, err)
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var idx, size, dataLen int64
		require.NoError(t, rows.Scan(&idx, &size, &dataLen))
		t.Logf("gen_metadata idx=%d size=%d data_len=%d", idx, size, dataLen)
	}

	var blob []byte
	err = db.QueryRow(`SELECT data FROM gen_metadata WHERE idx = 0`).Scan(&blob)
	if err == nil {
		fields, perr := parseFields(blob)
		if perr != nil {
			t.Logf("parseFields(gen_metadata[0]): %v", perr)
		}
		for _, f := range fields {
			t.Logf("gen_metadata[0] field=%d wire=%v varint=%d bytes_len=%d",
				f.Num, f.Wire, f.V, len(f.B))
		}
		t.Logf("workspace decoded: %q", decodeWorkspacePath(blob))
	}
}
