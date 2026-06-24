package panel

import "testing"

func TestDisplayAgent(t *testing.T) {
	cases := []struct{ raw, want string }{
		{"claude-code", "Claude Code"},
		{"codex", "Codex"},
		{"gemini", "Gemini"},
		{"antigravity", "Antigravity"},
		{"hermes", "Hermes"},
		{"cursor", "Cursor"},
		{"", ""},
	}
	for _, c := range cases {
		if got := displayAgent(c.raw); got != c.want {
			t.Errorf("displayAgent(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}

func TestDisplayModel(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"claude-opus-4-8", "Opus 4.8"},
		{"claude-opus-4-7", "Opus 4.7"},
		{"claude-sonnet-4-6", "Sonnet 4.6"},
		{"claude-haiku-4-5-20251001", "Haiku 4.5"}, // trailing date stamp dropped
		{"claude-3-5-sonnet", "Sonnet 3.5"},        // older number-first ordering
		{"claude-3-5-sonnet-20241022", "Sonnet 3.5"},
		{"gpt-5.5", "GPT-5.5"},
		{"gpt-5.4", "GPT-5.4"},
		{"gpt-5.3-codex", "GPT-5.3 Codex"},
		{"gemini-2.5-pro", "Gemini 2.5 Pro"},
		{"gemini-2.0-flash", "Gemini 2.0 Flash"},
		{"  claude-opus-4-8  ", "Opus 4.8"}, // trimmed
		{"", "(none)"},
		{"(none)", "(none)"},
		{"cursor-small", "Cursor Small"}, // unknown vendor → title-cased fallback
	}
	for _, c := range cases {
		if got := displayModel(c.raw); got != c.want {
			t.Errorf("displayModel(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}
