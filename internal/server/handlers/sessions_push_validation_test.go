package handlers

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidatePushedSessionID(t *testing.T) {
	for _, id := range []string{
		"session-a",
		"12345678-abcd-4ef0-9012-3456789abcde",
		"abc.DEF_123-xyz",
		strings.Repeat("a", 128),
	} {
		t.Run("valid "+id[:min(len(id), 20)], func(t *testing.T) {
			require.NoError(t, validatePushedSessionID(id))
		})
	}

	for _, tc := range []struct {
		name string
		id   string
	}{
		{name: "empty", id: ""},
		{name: "too long", id: strings.Repeat("a", 129)},
		{name: "slash", id: "victim/codex"},
		{name: "newline", id: "abc\nevent: forged"},
		{name: "dot dot", id: "../victim"},
		{name: "embedded dot dot", id: "abc..def"},
		{name: "unicode", id: "sessao-é"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Error(t, validatePushedSessionID(tc.id))
		})
	}
}

func TestValidatePushedAgent(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex", "cursor", "gemini", "antigravity", "hermes"} {
		t.Run("valid "+agent, func(t *testing.T) {
			require.NoError(t, validatePushedAgent(agent))
		})
	}

	for _, agent := range []string{"", "unknown", "codex\nforged", "../codex", "claude_code"} {
		t.Run("invalid "+agent, func(t *testing.T) {
			require.Error(t, validatePushedAgent(agent))
		})
	}
}
