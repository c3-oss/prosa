package sessiontext

import (
	"strings"
)

// UserMessage is the structured shape of a user turn after the
// boilerplate wrappers agents inject have been peeled off. Body is
// the human portion; the other fields hold the meta wrappers so
// renderers can present them discretely (chip, collapsible details)
// instead of dumping the raw XML on screen.
//
// Fields are populated only when the corresponding wrapper appears
// in the input. When a single wrapper type appears multiple times
// (e.g. several <system-reminder> blocks in one user turn), every
// occurrence is preserved in the slice fields.
type UserMessage struct {
	Command                 string   // <command-name> body
	CommandArgs             string   // <command-args> body
	CommandMessage          string   // <command-message> body
	Reminders               []string // one entry per <system-reminder>
	EnvContext              string   // <environment_context> body
	Instructions            string   // <INSTRUCTIONS> body
	CollaborationMode       string   // <collaboration_mode> body
	PermissionsInstructions string   // <permissions instructions> body (no closing tag — captured raw)
	LocalCommandCaveat      string   // <local-command-caveat> body
	LocalCommandStdout      string   // <local-command-stdout> body
	LocalCommandStderr      string   // <local-command-stderr> body
	Body                    string   // what's left after stripping wrappers
}

// IsEmpty reports whether the message carries nothing the renderer
// would surface — useful as a guard for "skip the user bubble".
func (m UserMessage) IsEmpty() bool {
	return m.Command == "" && m.CommandArgs == "" && m.CommandMessage == "" &&
		len(m.Reminders) == 0 && m.EnvContext == "" && m.Instructions == "" &&
		m.CollaborationMode == "" && m.PermissionsInstructions == "" &&
		m.LocalCommandCaveat == "" && m.LocalCommandStdout == "" &&
		m.LocalCommandStderr == "" && m.Body == ""
}

// HasExtras reports whether anything other than Body needs surfacing —
// the renderer uses this to decide if it should render the
// reminders/stdout/env_context disclosures at all.
func (m UserMessage) HasExtras() bool {
	return m.Command != "" || m.CommandArgs != "" || m.CommandMessage != "" ||
		len(m.Reminders) > 0 || m.EnvContext != "" || m.Instructions != "" ||
		m.CollaborationMode != "" || m.PermissionsInstructions != "" ||
		m.LocalCommandCaveat != "" || m.LocalCommandStdout != "" ||
		m.LocalCommandStderr != ""
}

// xmlWrapper is one tag-style wrapper we know how to extract.
// `tag` is the opening tag (without angles) e.g. "command-name";
// `closing` is the matching closer including angles, e.g.
// "</command-name>". `multi` is true when the wrapper can repeat in
// one message (system-reminder) — the parser will collect every
// occurrence instead of just the first.
type xmlWrapper struct {
	tag     string
	open    string // pre-rendered "<tag>"
	closing string // pre-rendered "</tag>"
	multi   bool
}

var userWrappers = []xmlWrapper{
	{tag: "command-name", open: "<command-name>", closing: "</command-name>"},
	{tag: "command-args", open: "<command-args>", closing: "</command-args>"},
	{tag: "command-message", open: "<command-message>", closing: "</command-message>"},
	{tag: "system-reminder", open: "<system-reminder>", closing: "</system-reminder>", multi: true},
	{tag: "environment_context", open: "<environment_context>", closing: "</environment_context>"},
	{tag: "INSTRUCTIONS", open: "<INSTRUCTIONS>", closing: "</INSTRUCTIONS>"},
	{tag: "collaboration_mode", open: "<collaboration_mode>", closing: "</collaboration_mode>"},
	{tag: "local-command-caveat", open: "<local-command-caveat>", closing: "</local-command-caveat>"},
	{tag: "local-command-stdout", open: "<local-command-stdout>", closing: "</local-command-stdout>"},
	{tag: "local-command-stderr", open: "<local-command-stderr>", closing: "</local-command-stderr>"},
}

// ParseUserMessage extracts every known wrapper from raw and returns
// what each carried plus the leftover Body. Wrappers are matched by
// `<tag>…</tag>` after the input is sanitized (ANSI/control chars
// stripped via SanitizeForDisplay).
//
// Order in the input is irrelevant — each wrapper is searched
// independently and removed from the working string. Body is then
// the trimmed remainder. Unknown text passes through untouched as
// Body.
//
// On a malformed wrapper (open tag with no closing) the open tag is
// left in Body so the user can still see *something* — better than
// silently swallowing the rest of the message.
func ParseUserMessage(raw string) UserMessage {
	sanitized := SanitizeForDisplay(raw)
	working := sanitized
	out := UserMessage{}

	// "<permissions instructions>" has no documented closing tag and
	// runs from the open tag until the next `<` (start of any other
	// tag) or end of input. Captured first so the other wrappers
	// still sit in the working string and serve as the "next `<`"
	// boundary.
	const permOpen = "<permissions instructions>"
	if idx := strings.Index(working, permOpen); idx >= 0 {
		afterTag := working[idx+len(permOpen):]
		end := len(afterTag)
		if i := strings.IndexByte(afterTag, '<'); i >= 0 {
			end = i
		}
		out.PermissionsInstructions = strings.TrimSpace(afterTag[:end])
		working = working[:idx] + afterTag[end:]
	}

	for _, w := range userWrappers {
		if w.multi {
			collected, rest := extractAll(working, w.open, w.closing)
			if len(collected) > 0 {
				assignWrapper(&out, w.tag, collected)
				working = rest
			}
			continue
		}
		if value, rest, ok := extractFirst(working, w.open, w.closing); ok {
			assignWrapper(&out, w.tag, []string{value})
			working = rest
		}
	}

	out.Body = strings.TrimSpace(working)
	return out
}

// extractFirst pulls the first occurrence of open…closing out of s.
// Returns the inner text (trimmed), the string with the wrapper
// removed, and ok=true. If the open token isn't present, ok=false.
// If open is present but closing isn't, ok=false (caller leaves the
// raw fragment in Body).
func extractFirst(s, open, closing string) (string, string, bool) {
	o := strings.Index(s, open)
	if o < 0 {
		return "", s, false
	}
	c := strings.Index(s[o+len(open):], closing)
	if c < 0 {
		return "", s, false
	}
	inner := s[o+len(open) : o+len(open)+c]
	rest := s[:o] + s[o+len(open)+c+len(closing):]
	return strings.TrimSpace(inner), rest, true
}

// extractAll repeatedly pulls open…closing pairs out of s, returning
// every inner body (trimmed) and the leftover string.
func extractAll(s, open, closing string) ([]string, string) {
	var out []string
	cur := s
	for {
		v, rest, ok := extractFirst(cur, open, closing)
		if !ok {
			break
		}
		out = append(out, v)
		cur = rest
	}
	return out, cur
}

// assignWrapper routes the parsed body(ies) for a given tag to the
// right struct field. Centralised so the parser loop stays declarative.
func assignWrapper(out *UserMessage, tag string, values []string) {
	if len(values) == 0 {
		return
	}
	switch tag {
	case "command-name":
		out.Command = values[0]
	case "command-args":
		out.CommandArgs = values[0]
	case "command-message":
		out.CommandMessage = values[0]
	case "system-reminder":
		out.Reminders = append(out.Reminders, values...)
	case "environment_context":
		out.EnvContext = values[0]
	case "INSTRUCTIONS":
		out.Instructions = values[0]
	case "collaboration_mode":
		out.CollaborationMode = values[0]
	case "local-command-caveat":
		out.LocalCommandCaveat = values[0]
	case "local-command-stdout":
		out.LocalCommandStdout = values[0]
	case "local-command-stderr":
		out.LocalCommandStderr = values[0]
	}
}
