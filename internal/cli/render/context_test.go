package render

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestContextLineProjectNotDetectedKeepsWindow(t *testing.T) {
	t.Parallel()

	got := ContextLine(ContextLineOptions{
		Command: "prosa",
		Source:  "local",
		Scope:   ScopeProjectNotDetected,
		Last:    "30d",
	})

	require.Equal(t, "prosa · local · project not detected · showing all projects · last 30d", got)
}

func TestContextLineAppendsUniformSegments(t *testing.T) {
	t.Parallel()

	got := ContextLine(ContextLineOptions{
		Command:        "prosa",
		Source:         "local",
		Scope:          ScopeAll,
		Last:           "1d",
		UniformProject: "mz-codes/mz-operator-1",
		UniformDevice:  "tbox",
	})
	require.Equal(t,
		"prosa · local · all projects · last 1d · project mz-codes/mz-operator-1 · device tbox",
		got)
}
