package paths

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestUserHomeUsesEnvironmentHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	got, err := UserHome()
	require.NoError(t, err)
	require.Equal(t, home, got)
}

func TestHomeFallsBackThroughUserHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PROSA_HOME", "")
	t.Setenv("XDG_DATA_HOME", "")

	got, err := Home()
	require.NoError(t, err)
	require.Equal(t, filepath.Join(home, ".local", "share", "prosa"), got)
}
