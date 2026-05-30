package render

import "strings"

// MetaPlaceholder is the muted token rendered in place of a
// boilerplate first_prompt so the column is never empty but the
// reader instantly knows the absence of real user content is
// intentional.
const MetaPlaceholder = "(meta)"

// boilerplatePrefixes are the literal starts agents inject as the
// first user-role message. When the stored first_prompt begins with
// any of these, the rendered value is replaced with MetaPlaceholder.
//
// Patterns observed in the wild:
//
//   - codex / claude-code: # AGENTS.md instructions for <path>
//   - claude-code: <command-name>/foo</command-name> command harness.
//   - claude-code: <system-reminder>…</system-reminder> meta blocks.
//   - claude-code: <command-args>…</command-args> harness args.
//   - claude-code: <INSTRUCTIONS> global instructions wrapper.
//
// Add to this list as new shapes show up — the match is a plain
// case-sensitive prefix test after trimming leading whitespace.
var boilerplatePrefixes = []string{
	"# AGENTS.md instructions for ",
	"<command-name>",
	"<command-args>",
	"<command-message>",
	"<system-reminder>",
	"<INSTRUCTIONS>",
	"<environment_context>",
}

// CleanFirstPrompt classifies the raw first_prompt. Returns the input
// untouched and true when it looks like real user content; returns
// the input untouched and false when it matches a known meta-message
// pattern. The renderer uses (clean, false) → MetaPlaceholder.
//
// Trimming leading whitespace handles cases where the importer kept
// leading newlines from the source JSONL — the prefix match still
// fires.
func CleanFirstPrompt(s string) (string, bool) {
	trimmed := strings.TrimLeft(s, " \t\r\n")
	for _, p := range boilerplatePrefixes {
		if strings.HasPrefix(trimmed, p) {
			return s, false
		}
	}
	return s, true
}

// RenderFirstPrompt is the convenience wrapper used by timeline and
// search: it classifies, falls back to MetaPlaceholder (muted style)
// when boilerplate is detected, and otherwise returns the cleaned
// text styled as normal foreground.
func RenderFirstPrompt(s string) string {
	clean, ok := CleanFirstPrompt(s)
	if !ok {
		return StyleMuted.Render(MetaPlaceholder)
	}
	return clean
}
