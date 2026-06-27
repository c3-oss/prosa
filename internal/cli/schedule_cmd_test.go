package cli

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/cli/schedule"
)

func TestEmitScheduleStatusJSONNotInstalled(t *testing.T) {
	var out bytes.Buffer

	require.NoError(t, emitScheduleStatusJSON(&out, schedule.State{}))

	var got map[string]any
	require.NoError(t, json.Unmarshal(out.Bytes(), &got))
	require.Equal(t, map[string]any{
		"status":    "not_installed",
		"installed": false,
	}, got)
}

func TestEmitScheduleStatusJSONInstalled(t *testing.T) {
	var out bytes.Buffer

	require.NoError(t, emitScheduleStatusJSON(&out, schedule.State{
		Installed: true,
		UnitPath:  "/tmp/prosa-sync.service",
		Interval:  15 * time.Minute,
	}))

	var got map[string]any
	require.NoError(t, json.Unmarshal(out.Bytes(), &got))
	require.Equal(t, map[string]any{
		"status":    "installed",
		"installed": true,
		"unit":      "/tmp/prosa-sync.service",
		"interval":  "15m0s",
	}, got)
}
