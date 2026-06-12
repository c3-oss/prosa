package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/importers/importertest"
	"github.com/c3-oss/prosa/pkg/importer"
)

type stubImporter struct {
	name string
	res  importer.ImportResult
	err  error
}

func (s stubImporter) Name() string                    { return s.name }
func (s stubImporter) DefaultRoots() []string          { return nil }
func (s stubImporter) RootsUnder(base string) []string { return []string{base} }
func (s stubImporter) Walk(context.Context, string) ([]string, error) {
	return nil, nil
}

func (s stubImporter) Import(context.Context, string, importer.Sink, importer.ImportOptions) (importer.ImportResult, error) {
	return s.res, s.err
}

func decodeJSONLines(t *testing.T, b []byte) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, ln := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if ln == "" {
			continue
		}
		var m map[string]any
		require.NoError(t, json.Unmarshal([]byte(ln), &m))
		out = append(out, m)
	}
	return out
}

func TestRunSyncJSONEmitsPerSessionRecords(t *testing.T) {
	work := []syncJob{
		{imp: stubImporter{name: "codex", res: importer.ImportResult{SessionID: "s1"}}, path: "/a"},
		{imp: stubImporter{name: "codex", res: importer.ImportResult{SessionID: "s2", Skipped: true}}, path: "/b"},
		{imp: stubImporter{name: "claude-code", err: errors.New("parse boom")}, path: "/c"},
	}

	var buf bytes.Buffer
	counts := &syncCounts{}
	err := runSyncJSON(context.Background(), &buf, work, importertest.NewSink(), nil, "dev", counts, importer.ImportOptions{})
	require.NoError(t, err)

	lines := decodeJSONLines(t, buf.Bytes())
	require.Len(t, lines, 3)

	require.Equal(t, "session", lines[0]["type"])
	require.Equal(t, "imported", lines[0]["status"])
	require.Equal(t, "s1", lines[0]["session_id"])
	require.Equal(t, "disabled", lines[0]["push"]) // push == nil

	require.Equal(t, "skipped", lines[1]["status"])

	require.Equal(t, "error", lines[2]["status"])
	require.Equal(t, "parse boom", lines[2]["err"])

	require.Equal(t, 1, counts.liveImp)
	require.Equal(t, 1, counts.liveSkip)
	require.Equal(t, 1, counts.liveErr)
}

func TestEmitSyncJSONSummary(t *testing.T) {
	var buf bytes.Buffer
	emitSyncJSONSummary(&buf, &syncCounts{
		liveImp: 3, legacyImp: 1, liveSkip: 2, liveErr: 1,
		pushImp: 4, pushSkip: 1, pushErr: 1,
		catchUpSent: 5, catchUpSkip: 2, catchUpErr: 0,
	})
	lines := decodeJSONLines(t, buf.Bytes())
	require.Len(t, lines, 1)
	s := lines[0]
	require.Equal(t, "summary", s["type"])
	require.EqualValues(t, 4, s["imported"]) // 3 live + 1 legacy
	require.EqualValues(t, 2, s["skipped"])
	require.EqualValues(t, 1, s["errors"])
	require.EqualValues(t, 4, s["push_sent"])
	require.EqualValues(t, 5, s["catchup_sent"])
}

func TestPushStatusString(t *testing.T) {
	require.Equal(t, "sent", pushStatusString(pushImported))
	require.Equal(t, "skipped", pushStatusString(pushAlreadyHashed))
	require.Equal(t, "skipped", pushStatusString(pushSkippedNoUsage))
	require.Equal(t, "failed", pushStatusString(pushFailed))
	require.Equal(t, "unavailable", pushStatusString(pushSkippedRemoteUnavailable))
}
