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
