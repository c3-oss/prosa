package render

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDeviceLabelFromMap(t *testing.T) {
	m := map[string]string{
		"58c0e6b17377a444": "Studio M4",
	}
	require.Equal(t, "Studio M4", DeviceLabel(m, "58c0e6b17377a444"))
}

func TestDeviceLabelFallsBackToTruncatedHex(t *testing.T) {
	require.Equal(t, "58c0e6b…", DeviceLabel(nil, "58c0e6b17377a444"))
	require.Equal(t, "58c0e6b…", DeviceLabel(map[string]string{}, "58c0e6b17377a444"))
	// Empty friendly_name also falls back.
	require.Equal(t, "58c0e6b…", DeviceLabel(map[string]string{"58c0e6b17377a444": ""}, "58c0e6b17377a444"))
}

func TestDeviceLabelShortID(t *testing.T) {
	require.Equal(t, "abc", DeviceLabel(nil, "abc"))
}
