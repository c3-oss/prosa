package claudecode

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/importers/importerutil"
)

// A planted transcript whose interior sessionId escapes the raw root must
// be rejected before any filesystem write, closing the path-traversal
// overwrite primitive described in issue #86.
func TestPreserveRawRejectsTraversalSessionID(t *testing.T) {
	home := filepath.Join(t.TempDir(), "prosa-home")
	t.Setenv("PROSA_HOME", home)

	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "transcript.jsonl")
	require.NoError(t, os.WriteFile(src, []byte(`{"sessionId":"x"}`+"\n"), 0o644))

	victim := filepath.Join(srcDir, "victim")
	require.NoError(t, os.WriteFile(victim, []byte("original"), 0o644))

	for _, id := range []string{
		"../../../../../../" + victim,
		"../escape",
		"a/b",
		"bad\nid",
		"",
	} {
		t.Run(id, func(t *testing.T) {
			dst, err := importerutil.PreserveRaw(Name, id, ".jsonl", time.Now(), src)
			require.Error(t, err)
			require.Empty(t, dst)
		})
	}

	// The victim file is untouched and no escaped artifact was written.
	got, err := os.ReadFile(victim)
	require.NoError(t, err)
	require.Equal(t, "original", string(got))
}

func TestPreserveRawAcceptsValidSessionID(t *testing.T) {
	home := filepath.Join(t.TempDir(), "prosa-home")
	t.Setenv("PROSA_HOME", home)

	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "transcript.jsonl")
	require.NoError(t, os.WriteFile(src, []byte(`{"sessionId":"x"}`+"\n"), 0o644))

	dst, err := importerutil.PreserveRaw(
		Name,
		"12345678-abcd-4ef0-9012-3456789abcde",
		".jsonl",
		time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC),
		src,
	)
	require.NoError(t, err)
	require.FileExists(t, dst)
	require.True(t, filepath.IsAbs(dst))
}
