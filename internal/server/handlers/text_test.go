package handlers

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPGTextReplacesNULBytes(t *testing.T) {
	require.Equal(t, "plain text", pgText("plain text"))
	require.Equal(t, "before after", pgText("before\x00after"))
	require.Equal(t, "  ", pgText("\x00\x00"))
	require.NotContains(t, pgText("a\x00b\x00c"), "\x00")
}

func TestNullIfEmptySanitizesNonEmptyText(t *testing.T) {
	require.Nil(t, nullIfEmpty(""))
	require.Equal(t, "a b", nullIfEmpty("a\x00b"))
}
