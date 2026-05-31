package render

import "github.com/c3-oss/prosa/internal/sessiontext"

// MetaPlaceholder is the muted token rendered in place of a
// boilerplate first_prompt so the column is never empty but the
// reader instantly knows the absence of real user content is
// intentional.
const MetaPlaceholder = "(meta)"

// CleanFirstPrompt classifies the raw first_prompt. Returns the
// best-effort human portion (stripping known wrapper blocks when one
// surrounds a real prompt) and a boolean reporting whether the result
// is real user content. The renderer uses (_, false) → MetaPlaceholder.
//
// Patterns and wrapper logic live in internal/sessiontext so importers,
// the SQL denoise mirror, and this renderer all agree.
func CleanFirstPrompt(s string) (string, bool) {
	cleaned := sessiontext.CleanPrompt(s)
	if sessiontext.IsBoilerplatePrompt(cleaned) {
		return s, false
	}
	return cleaned, true
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
