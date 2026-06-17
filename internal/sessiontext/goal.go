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
	return obj, budgetBlock(inner), strings.TrimSpace(rest), true
}

// budgetBlock returns the "Budget:" paragraph from s — the header plus the
// lines that follow it until the next blank line. Empty when no Budget.
func budgetBlock(s string) string {
	idx := strings.Index(s, "Budget:")
	if idx < 0 {
		return ""
	}
	block := s[idx:]
	if end := strings.Index(block, "\n\n"); end >= 0 {
		block = block[:end]
	}
	return strings.TrimSpace(block)
}
