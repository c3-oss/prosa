package sessiontext

import "strings"

// Codex goal sessions wrap the human request in an injected context block
// that re-appears on every turn. The block carries a lot of scaffolding
// (continuation rules, a Budget readout, a completion audit) around the
// real task, which lives in <objective>…</objective>. These helpers peel
// the wrapper so the timeline shows the objective, not the scaffold.
const (
	goalWrapperOpen  = `<codex_internal_context source="goal">`
	goalWrapperClose = `</codex_internal_context>`
)

// IsGoalWrapper reports whether s is a Codex goal context block. Leading
// whitespace and control characters are tolerated.
func IsGoalWrapper(s string) bool {
	return strings.HasPrefix(strings.TrimLeft(SanitizeForDisplay(s), " \t\r\n"), goalWrapperOpen)
}

// ExtractGoalObjective returns the human <objective> buried inside a goal
// wrapper. ok is false when s is not a goal wrapper or carries no
// objective block.
func ExtractGoalObjective(s string) (string, bool) {
	obj, _, _, ok := splitGoal(SanitizeForDisplay(s))
	if !ok || obj == "" {
		return "", false
	}
	return obj, true
}

// ExtractGoalBudget returns the "Budget:" block (header plus its bullet
// lines, up to the next blank line) from a goal wrapper. Empty when absent.
func ExtractGoalBudget(s string) string {
	_, budget, _, _ := splitGoal(SanitizeForDisplay(s))
	return budget
}

// splitGoal peels a goal wrapper into the human objective, the Budget
// block, and the remaining scaffold (everything else inside the wrapper,
// objective removed). ok is false when sanitized is not a goal wrapper.
// sanitized is expected to already be control-stripped.
func splitGoal(sanitized string) (objective, budget, scaffold string, ok bool) {
	if !strings.HasPrefix(strings.TrimLeft(sanitized, " \t\r\n"), goalWrapperOpen) {
		return "", "", "", false
	}
	_, inner, _ := strings.Cut(sanitized, goalWrapperOpen)
	if before, _, found := strings.Cut(inner, goalWrapperClose); found {
		inner = before
	}
	obj, rest, found := extractFirst(inner, "<objective>", "</objective>")
	if !found {
		obj, rest = "", inner
	}
	// The budget paragraph is surfaced on its own disclosure, so strip it
	// from the scaffold to avoid showing the same lines twice.
	return obj, budgetBlock(inner), strings.TrimSpace(stripBudget(rest)), true
}

// budgetSpan locates the "Budget:" paragraph in s — from the header to the
// next blank line (or end of input). ok is false when there is no Budget.
func budgetSpan(s string) (start, end int, ok bool) {
	start = strings.Index(s, "Budget:")
	if start < 0 {
		return 0, 0, false
	}
	end = len(s)
	if rel := strings.Index(s[start:], "\n\n"); rel >= 0 {
		end = start + rel
	}
	return start, end, true
}

// budgetBlock returns the trimmed "Budget:" paragraph. Empty when absent.
func budgetBlock(s string) string {
	start, end, ok := budgetSpan(s)
	if !ok {
		return ""
	}
	return strings.TrimSpace(s[start:end])
}

// stripBudget removes the "Budget:" paragraph (and its trailing blank line)
// from s. Returns s unchanged when there is no Budget block.
func stripBudget(s string) string {
	start, end, ok := budgetSpan(s)
	if !ok {
		return s
	}
	for end < len(s) && (s[end] == '\n' || s[end] == '\r') {
		end++
	}
	return s[:start] + s[end:]
}
