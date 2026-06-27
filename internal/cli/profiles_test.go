package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestProfilesMutatorsEmitJSON(t *testing.T) {
	originalFlags := g
	t.Cleanup(func() { g = originalFlags })
	t.Setenv("PROSA_CONFIG_HOME", filepath.Join(t.TempDir(), "config"))

	path1 := t.TempDir()
	path2 := t.TempDir()
	for _, tc := range []struct {
		name string
		args []string
		want profileMutationJSON
	}{
		{
			name: "add",
			args: []string{"profiles", "add", "codex", "audit", path1, "--json"},
			want: profileMutationJSON{Action: "add", Agent: "codex", Profile: "audit", Path: path1},
		},
		{
			name: "set-path",
			args: []string{"profiles", "set-path", "codex", "audit", path2, "--json"},
			want: profileMutationJSON{Action: "set_path", Agent: "codex", Profile: "audit", Path: path2},
		},
		{
			name: "remove",
			args: []string{"profiles", "remove", "codex", "audit", "--json"},
			want: profileMutationJSON{Action: "remove", Agent: "codex", Profile: "audit"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stdout, stderr, err := executeProfilesCommandForTest(t, tc.args...)
			require.NoError(t, err)
			require.Empty(t, stderr)

			var got profileMutationJSON
			require.NoError(t, json.Unmarshal(bytes.TrimSpace([]byte(stdout)), &got))
			require.Equal(t, tc.want, got)
		})
	}
}

func executeProfilesCommandForTest(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	var execErr error
	stdout, stderr := captureStdoutStderr(t, func() {
		cmd := newRootCmd()
		cmd.SetArgs(args)
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		execErr = cmd.Execute()
	})
	return stdout, stderr, execErr
}
