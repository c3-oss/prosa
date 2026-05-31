// Package sessiontext classifies and cleans the operational/meta blocks
// agents inject as the first user-role message of a session. Centralized
// here so importers, renderers, and the store-level denoise mirror all
// share one source of truth — the master pattern list lives in Prefixes.
package sessiontext

import "strings"

// Prefixes is the master list of literal starts agents inject as
// user-role messages that should not be treated as real human prompts.
// Match is a plain case-sensitive HasPrefix after trimming leading
// whitespace.
//
// The list is exported so the SQL mirror in
// internal/store.ListSessionsWithBoilerplatePrompt can iterate the same
// patterns instead of duplicating them.
//
// Patterns observed in the wild:
//
//   - codex / claude-code: # AGENTS.md instructions for <path>
//   - claude-code: <command-name>…</command-name> harness wrappers.
//   - claude-code: <command-args>…</command-args> harness args.
//   - claude-code: <command-message>…</command-message> harness slug.
//   - claude-code: <system-reminder>…</system-reminder> meta blocks.
//   - claude-code: <INSTRUCTIONS> global instructions wrapper.
//   - claude-code: <environment_context> session environment dump.
//   - claude-code: <permissions instructions> permission preface.
//   - claude-code: <collaboration_mode> mode prefix.
//   - claude-code: <local-command-caveat> wrapper before slash-command body.
//   - codex: You are Codex, a coding agent (system role leaking through).
//   - codex: Knowledge cutoff: <date> (system role leaking through).
var Prefixes = []string{
	"# AGENTS.md instructions for ",
	"<command-name>",
	"<command-args>",
	"<command-message>",
	"<system-reminder>",
	"<INSTRUCTIONS>",
	"<environment_context>",
	"<permissions instructions>",
	"<collaboration_mode>",
	"<local-command-caveat>",
	"You are Codex, a coding agent",
	"Knowledge cutoff:",
}

// IsBoilerplatePrompt reports whether s, after best-effort cleaning,
// still classifies as one of the known meta prefixes. Use this to decide
// whether to render a (meta) placeholder.
func IsBoilerplatePrompt(s string) bool {
	return hasBoilerplatePrefix(CleanPrompt(s))
}

// CleanPrompt strips leading wrapper blocks (tag-style: <foo>…</foo>)
// and returns the trimmed human portion that follows. Non-wrapper
// prefixes (e.g. "# AGENTS.md instructions for ", "You are Codex, …")
// have no closing marker, so the whole input is meta and the original
// string is returned — the caller can detect that via
// IsBoilerplatePrompt and fall back to a placeholder.
//
// Returns the original input untouched when:
//
//   - the input does not start with any known prefix; or
//   - all that remains after stripping wrappers is empty.
func CleanPrompt(s string) string {
	cur := strings.TrimLeft(s, " \t\r\n")
	for {
		progressed := false
		for _, p := range Prefixes {
			if !strings.HasPrefix(cur, p) {
				continue
			}
			if strings.HasPrefix(p, "<") && strings.HasSuffix(p, ">") {
				tag := p[1 : len(p)-1]
				closing := "</" + tag + ">"
				if idx := strings.Index(cur, closing); idx >= 0 {
					cur = strings.TrimLeft(cur[idx+len(closing):], " \t\r\n")
					progressed = true
					break
				}
			}
			return s
		}
		if !progressed {
			break
		}
	}
	if cur == "" {
		return s
	}
	return cur
}

// FirstNonBoilerplate returns the first candidate whose cleaned form
// passes IsBoilerplatePrompt. Useful for importers that want to skip
// system/developer messages and meta wrappers without inventing custom
// loops at every call site. Returns "" when all candidates are meta.
func FirstNonBoilerplate(candidates []string) string {
	for _, c := range candidates {
		cleaned := strings.TrimSpace(CleanPrompt(c))
		if cleaned == "" {
			continue
		}
		if IsBoilerplatePrompt(cleaned) {
			continue
		}
		return cleaned
	}
	return ""
}

func hasBoilerplatePrefix(s string) bool {
	trimmed := strings.TrimLeft(s, " \t\r\n")
	for _, p := range Prefixes {
		if strings.HasPrefix(trimmed, p) {
			return true
		}
	}
	return false
}
