package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/importers/importertest"
	"github.com/c3-oss/prosa/pkg/importer"
)

// TestRegisteredImportersRootsUnder asserts every importer derives its scan
// roots from the profile base directory, so a configured profile path always
// expands to something under it.
func TestRegisteredImportersRootsUnder(t *testing.T) {
	for _, imp := range registeredImporters() {
		roots := imp.RootsUnder("/tmp/base")
		require.NotEmpty(t, roots, imp.Name())
		for _, r := range roots {
			require.True(t, strings.HasPrefix(r, "/tmp/base"),
				"%s root %q is not under the profile base", imp.Name(), r)
		}
	}
}

// recordingImporter captures the ImportOptions.Profile it was called with.
type recordingImporter struct {
	name string
	got  *string
}

func (r recordingImporter) Name() string                    { return r.name }
func (r recordingImporter) DefaultRoots() []string          { return nil }
func (r recordingImporter) RootsUnder(base string) []string { return []string{base} }
func (r recordingImporter) Walk(context.Context, string) ([]string, error) {
	return nil, nil
}

func (r recordingImporter) Import(_ context.Context, _ string, _ importer.Sink, opts importer.ImportOptions) (importer.ImportResult, error) {
	*r.got = opts.Profile
	return importer.ImportResult{SessionID: "s1"}, nil
}

// TestSyncThreadsProfileIntoImport asserts a syncJob's profile reaches the
// importer through per-job ImportOptions, even though the base opts is shared.
func TestSyncThreadsProfileIntoImport(t *testing.T) {
	var got string
	work := []syncJob{{
		imp:     recordingImporter{name: "codex", got: &got},
		path:    "/a",
		profile: "work",
	}}
	var buf bytes.Buffer
	err := runSyncJSON(context.Background(), &buf, work, importertest.NewSink(), nil, "dev", &syncCounts{}, importer.ImportOptions{})
	require.NoError(t, err)
	require.Equal(t, "work", got)
}
