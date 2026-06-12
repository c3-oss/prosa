package profiles

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// fakeImporter is a minimal rooter for Resolve tests.
type fakeImporter struct{}

func (fakeImporter) DefaultRoots() []string { return []string{"/home/.agent/sessions"} }
func (fakeImporter) RootsUnder(base string) []string {
	return []string{filepath.Join(base, "sessions")}
}

func withConfigHome(t *testing.T) {
	t.Helper()
	t.Setenv("PROSA_CONFIG_HOME", t.TempDir())
}

func TestLoadMissingFileIsEmpty(t *testing.T) {
	withConfigHome(t)
	c, err := Load()
	require.NoError(t, err)
	require.NotNil(t, c.Agents)
	require.Empty(t, c.For("codex"))
}

func TestSaveLoadRoundTrip(t *testing.T) {
	withConfigHome(t)
	var c Config
	c.Set("codex", Profile{Name: "work", Path: "/home/.codex-work"})
	c.Set("codex", Profile{Name: "alt", Path: "/home/.codex-alt"})
	require.NoError(t, Save(c))

	got, err := Load()
	require.NoError(t, err)
	require.Equal(t, Version, got.Version)
	ps := got.For("codex")
	require.Len(t, ps, 2)
	require.Equal(t, "alt", ps[0].Name)
	require.Equal(t, "work", ps[1].Name)
}

func TestSetReplacesAndRemove(t *testing.T) {
	var c Config
	require.False(t, c.Set("codex", Profile{Name: "work", Path: "/a"}))
	require.True(t, c.Set("codex", Profile{Name: "work", Path: "/b"}))
	p, ok := c.Find("codex", "work")
	require.True(t, ok)
	require.Equal(t, "/b", p.Path)

	require.True(t, c.Remove("codex", "work"))
	_, ok = c.Find("codex", "work")
	require.False(t, ok)
	require.NotContains(t, c.Agents, "codex")
	require.False(t, c.Remove("codex", "work"))
}

func TestResolveSynthesizesDefault(t *testing.T) {
	var c Config
	got := c.Resolve("codex", fakeImporter{})
	require.Len(t, got, 1)
	require.Equal(t, "default", got[0].Name)
	require.Equal(t, []string{"/home/.agent/sessions"}, got[0].Roots)
	require.Empty(t, got[0].Path, "synthesized default has no stored base path")
}

func TestResolveDefaultFirstThenExtras(t *testing.T) {
	var c Config
	c.Set("codex", Profile{Name: "work", Path: "/home/.codex-work"})
	got := c.Resolve("codex", fakeImporter{})
	require.Len(t, got, 2)
	require.Equal(t, "default", got[0].Name)
	require.Equal(t, "work", got[1].Name)
	require.Equal(t, []string{"/home/.codex-work/sessions"}, got[1].Roots)
}

func TestResolveDefaultOverride(t *testing.T) {
	var c Config
	c.Set("codex", Profile{Name: "default", Path: "/home/.codex-elsewhere"})
	got := c.Resolve("codex", fakeImporter{})
	require.Len(t, got, 1)
	require.Equal(t, "default", got[0].Name)
	require.Equal(t, []string{"/home/.codex-elsewhere/sessions"}, got[0].Roots,
		"a configured default overrides DefaultRoots via RootsUnder")
}
