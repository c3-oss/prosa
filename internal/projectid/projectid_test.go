package projectid

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func gitAvailable() bool {
	_, err := exec.LookPath("git")
	return err == nil
}

func gitInit(t *testing.T, dir, remoteURL string) {
	t.Helper()
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "git %v: %s", args, out)
	}
	run("init", "-q", "-b", "main")
	run("config", "user.email", "test@test")
	run("config", "user.name", "test")
	run("remote", "add", "origin", remoteURL)
}

func TestResolveWithGitRemote(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git binary not available")
	}
	dir := t.TempDir()
	gitInit(t, dir, "git@github.com:example/proj.git")

	id := Resolve(dir)
	require.NotNil(t, id.Remote)
	require.Equal(t, "git@github.com:example/proj.git", *id.Remote)
	require.Nil(t, id.Marker)
	require.Equal(t, filepath.Clean(dir), id.Path)
}

func TestResolveWithMarkerAtRoot(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(
		filepath.Join(dir, ".prosa.yaml"),
		[]byte("project: my-proj\n"),
		0o644,
	))
	id := Resolve(dir)
	require.NotNil(t, id.Marker)
	require.Equal(t, "my-proj", *id.Marker)
}

func TestResolveWithMarkerAtAncestor(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.WriteFile(
		filepath.Join(root, ".prosa.yaml"),
		[]byte("project: ancestor-proj\n"),
		0o644,
	))
	sub := filepath.Join(root, "deep", "nested")
	require.NoError(t, os.MkdirAll(sub, 0o755))

	id := Resolve(sub)
	require.NotNil(t, id.Marker)
	require.Equal(t, "ancestor-proj", *id.Marker)
}

func TestResolveFallbackToCwd(t *testing.T) {
	dir := t.TempDir()
	id := Resolve(dir)
	require.Nil(t, id.Remote)
	require.Nil(t, id.Marker)
	require.Equal(t, filepath.Clean(dir), id.Path)
}

func TestResolveMissingCwd(t *testing.T) {
	id := Resolve("/nonexistent/path/should/not/exist")
	require.Nil(t, id.Remote)
	require.Nil(t, id.Marker)
	require.Equal(t, "/nonexistent/path/should/not/exist", id.Path)
}

func TestMarkerParserVariants(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{
		"plain":              "project: foo\n",
		"quoted":             "project: \"foo bar\"\n",
		"comment-trailing":   "project: foo  # hi\n",
		"surrounding-blank":  "\n\nproject: foo\n",
		"other-keys-ignored": "irrelevant: x\nproject: foo\n",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(dir, name+".yaml")
			require.NoError(t, os.WriteFile(path, []byte(body), 0o644))
			got, ok := readProjectKey(path)
			require.True(t, ok)
			if name == "quoted" {
				require.Equal(t, "foo bar", got)
			} else {
				require.Equal(t, "foo", got)
			}
		})
	}
}

func TestResolveBothRemoteAndMarker(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git binary not available")
	}
	dir := t.TempDir()
	gitInit(t, dir, "https://github.com/example/proj.git")
	require.NoError(t, os.WriteFile(
		filepath.Join(dir, ".prosa.yaml"),
		[]byte("project: explicit-name\n"),
		0o644,
	))
	id := Resolve(dir)
	require.NotNil(t, id.Remote)
	require.NotNil(t, id.Marker)
	require.Equal(t, "https://github.com/example/proj.git", *id.Remote)
	require.Equal(t, "explicit-name", *id.Marker)
}
