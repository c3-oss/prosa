package storage

import (
	"io/fs"
	"testing"

	"github.com/stretchr/testify/require"

	migrations "github.com/c3-oss/prosa/migrations/server"
)

func TestServerPanelPreferencesMigration(t *testing.T) {
	up, err := fs.ReadFile(migrations.FS, "0012_panel_preferences.up.sql")
	require.NoError(t, err)
	require.Contains(t, string(up), "CREATE TABLE panel_preferences")
	require.Contains(t, string(up), "PRIMARY KEY (owner_email, pref_key)")

	down, err := fs.ReadFile(migrations.FS, "0012_panel_preferences.down.sql")
	require.NoError(t, err)
	require.Contains(t, string(down), "DROP TABLE IF EXISTS panel_preferences")
}
