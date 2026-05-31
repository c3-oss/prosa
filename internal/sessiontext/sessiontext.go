// Package sessiontext classifies and cleans the operational/meta blocks
// agents inject as the first user-role message of a session. Centralized
// here so importers, renderers, and the store-level denoise mirror all
// share one source of truth — the master pattern list lives in Prefixes.
package sessiontext

import (
	"regexp"
	"strings"
)

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
//   - claude-code: <local-command-stdout>…</local-command-stdout> captured stdout (often ANSI-laden).
//   - claude-code: <local-command-stderr>…</local-command-stderr> captured stderr.
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
	"<local-command-stdout>",
	"<local-command-stderr>",
	"You are Codex, a coding agent",
	"Knowledge cutoff:",
}

// ansiCSI matches ECMA-48 CSI sequences (e.g. \x1b[1m, \x1b[31;1m,
// \x1b[?25h). Parameter bytes 0x30-0x3F, intermediate bytes 0x20-0x2F,
// final byte 0x40-0x7E.
var ansiCSI = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

// ansiOther matches single-byte Fe escape sequences (e.g. \x1bD index,
// \x1bM reverse-index). Range covers the C1 set 0x40-0x5F. Apply after
// ansiCSI so the CSI \x1b[ form is consumed first.
var ansiOther = regexp.MustCompile(`\x1b[@-_]`)

// sanitizeControl strips ANSI escape sequences (CSI + Fe singles) and
// other control characters from s. Whitespace (\t \n \r) and printable
// runes are preserved. Use for any text that may have leaked from a
// terminal or process that wrote escape codes.
func sanitizeControl(s string) string {
	if s == "" {
		return s
	}
	if strings.IndexByte(s, '\x1b') >= 0 {
		s = ansiCSI.ReplaceAllString(s, "")
		s = ansiOther.ReplaceAllString(s, "")
	}
	return strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return r
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
}

// SanitizeForDisplay removes ANSI escape sequences and control
// characters from s. Renderers in the panel/CLI use this to keep
// terminal-leaked content from showing as invisible glyphs.
func SanitizeForDisplay(s string) string {
	return sanitizeControl(s)
}

// IsBoilerplatePrompt reports whether s, after best-effort cleaning,
// still classifies as one of the known meta prefixes. Use this to decide
// whether to render a (meta) placeholder.
func IsBoilerplatePrompt(s string) bool {
	return hasBoilerplatePrefix(CleanPrompt(s))
}

// CleanPrompt strips leading wrapper blocks (tag-style: <foo>…</foo>)
// and returns the trimmed human portion that follows. ANSI escape
// sequences and control characters are removed first, so wrappers laden
// with terminal codes (e.g. <local-command-stdout>␛[1m…␛[22m</…>) are
// recognized.
//
// Non-wrapper prefixes (e.g. "# AGENTS.md instructions for ",
// "You are Codex, …") have no closing marker, so the whole input is
// meta — the sanitized input is returned and the caller can detect that
// via IsBoilerplatePrompt and fall back to a placeholder.
//
// Returns the sanitized input untouched when:
//
//   - the input does not start with any known prefix; or
//   - all that remains after stripping wrappers is empty.
func CleanPrompt(s string) string {
	sanitized := sanitizeControl(s)
	cur := strings.TrimLeft(sanitized, " \t\r\n")
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
			return sanitized
		}
		if !progressed {
			break
		}
	}
	if cur == "" {
		return sanitized
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

// BuildFirstPrompt returns the cleaned, whitespace-collapsed, rune-
// truncated form of text suitable for the timeline's FirstPrompt field.
// Returns ("", false) when text is empty, wholly boilerplate/meta, or
// becomes empty after sanitization. maxRunes <= 0 also returns false.
//
// Each importer owns its own truncation limit (claude-code/codex use
// 200; cursor/gemini/hermes likewise) so it is passed explicitly here.
func BuildFirstPrompt(text string, maxRunes int) (string, bool) {
	if maxRunes <= 0 {
		return "", false
	}
	if IsBoilerplatePrompt(text) {
		return "", false
	}
	cleaned := strings.TrimSpace(CleanPrompt(text))
	if cleaned == "" {
		return "", false
	}
	return truncRunes(strings.Join(strings.Fields(cleaned), " "), maxRunes), true
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

func truncRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + "…"
}
