package session

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidateID(t *testing.T) {
	valid := []string{
		"12345678-abcd-4ef0-9012-3456789abcde",
		"session-a",
		"abc.DEF_123-xyz",
		"a",
		strings.Repeat("a", MaxIDLen),
	}
	for _, id := range valid {
		t.Run("valid/"+id[:min(len(id), 16)], func(t *testing.T) {
			require.NoError(t, ValidateID(id))
		})
	}

	invalid := []struct {
		name string
		id   string
	}{
		{"empty", ""},
		{"too long", strings.Repeat("a", MaxIDLen+1)},
		{"slash", "victim/codex"},
		{"backslash", `victim\codex`},
		{"newline", "abc\nevent: forged"},
		{"traversal", "../../../home/cain/.ssh/authorized_keys"},
		{"embedded dot dot", "abc..def"},
		{"leading dot dot", "..foo"},
		{"unicode", "sessão"},
		{"space", "a b"},
	}
	for _, tc := range invalid {
		t.Run("invalid/"+tc.name, func(t *testing.T) {
			require.Error(t, ValidateID(tc.id))
		})
	}
}
