package cli

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"

	"github.com/c3-oss/prosa/internal/legacy"
	"github.com/c3-oss/prosa/pkg/importer"
)

const missingLegacyOID = "26086ba343a385b9b9e4569972125008398da65020557c2206c1c4ae09851829"

func TestPrepareLegacyWorkCountsMissingSourceAsError(t *testing.T) {
	ctx := context.Background()
	root, originalPath := buildMissingSourceLegacyBundle(t)

	bundle, err := legacy.Open(root)
	require.NoError(t, err)
	t.Cleanup(func() { _ = bundle.Close() })

	files, err := bundle.SourceFiles(ctx)
	require.NoError(t, err)
	require.Len(t, files, 1)

	work, err := prepareLegacyWork(ctx, bundle, files, t.TempDir())
	require.NoError(t, err)
	require.Len(t, work, 1)
	require.True(t, work[0].legacy)
	require.Equal(t, originalPath, work[0].path)
	require.Equal(t, "claude-code", work[0].imp.Name())
	require.Error(t, work[0].prepareErr)

	counts := &syncCounts{legacyTotal: len(files), bundlePath: root}
	require.NoError(t, runSyncPlain(ctx, work, nil, nil, counts, importer.ImportOptions{}))
	require.Equal(t, 1, counts.legacyErr)
	require.Equal(t, 0, counts.legacyImp)
	require.Equal(t, 0, counts.legacySkip)
	require.Contains(t, counts.legacySummaryText(), "partially mirrored")
}

func TestSyncLegacyPartialMirrorReturnsError(t *testing.T) {
	originalFlags := g
	originalLegacyBundleFlag := legacyBundleFlag
	originalVerboseFlag := syncVerboseFlag
	originalOverwriteFlag := syncOverwriteFlag
	t.Cleanup(func() {
		g = originalFlags
		legacyBundleFlag = originalLegacyBundleFlag
		syncVerboseFlag = originalVerboseFlag
		syncOverwriteFlag = originalOverwriteFlag
	})

	root, _ := buildMissingSourceLegacyBundle(t)
	tmp := t.TempDir()
	t.Setenv("HOME", filepath.Join(tmp, "home"))
	t.Setenv("PROSA_HOME", filepath.Join(tmp, "prosa-data"))
	t.Setenv("PROSA_CONFIG_HOME", filepath.Join(tmp, "prosa-config"))

	cmd := newRootCmd()
	cmd.SetArgs([]string{"sync", "--legacy-bundle", root, "--verbose"})

	err := cmd.Execute()
	require.Error(t, err)
	require.ErrorContains(t, err, "legacy bundle partially mirrored with 1 error")
}

func buildMissingSourceLegacyBundle(t *testing.T) (string, string) {
	t.Helper()

	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "raw", "sources"), 0o755))

	db, err := sql.Open("sqlite", filepath.Join(root, "prosa.sqlite"))
	require.NoError(t, err)
	_, err = db.Exec(`CREATE TABLE source_files (
		source_file_id TEXT, source_tool TEXT, path TEXT,
		object_id TEXT, size_bytes INTEGER
	)`)
	require.NoError(t, err)
	const originalPath = "/Users/u/.claude/projects/proj/session.jsonl"
	_, err = db.Exec(`INSERT INTO source_files VALUES (?, ?, ?, ?, ?)`,
		"sf-"+missingLegacyOID, "claude", originalPath, "blake3:"+missingLegacyOID, 42)
	require.NoError(t, err)
	require.NoError(t, db.Close())

	return root, originalPath
}
