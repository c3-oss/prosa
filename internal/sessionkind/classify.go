// Package sessionkind classifies a session into zero-or-more "special
// session" kinds from the turns and tool counters an importer already
// projected. The result is stored in the session_kinds table and surfaced
// in the panel as badges, a filter, and an insights breakdown.
//
// Classify covers the kinds derivable from a single session in isolation
// (goal, workflow, ralph-loop). The orchestrator kind depends on child
// edges that may not exist at single-session projection time, so it is
// computed post-sweep by the store (see store.RefreshOrchestratorKinds).
package sessionkind

import (
	"slices"
	"sort"
	"strings"

	"github.com/c3-oss/prosa/pkg/session"
)

// Kind constants. These are the canonical values written to session_kinds
// and matched by the panel's Kind filter.
const (
	// KindGoal marks a Codex goal session: the first user turn is wrapped
	// in <codex_internal_context source="goal">.
	KindGoal = "goal"
	// KindWorkflow marks a Claude Code dynamic workflow: the session used
	// the Workflow tool.
	KindWorkflow = "workflow"
	// KindRalphLoop marks a Claude Code Ralph Loop run, detected by the
	// /ralph-loop:ralph-loop slash command.
	KindRalphLoop = "ralph-loop"
	// KindOrchestrator marks a session that spawned subagents. Set by the
	// store from parent/child edges, not by Classify.
	KindOrchestrator = "orchestrator"
)

// goalPrefix is the literal start of a Codex goal session's first user
// turn. The wrapper re-injects every turn with an updated Budget block.
const goalPrefix = `<codex_internal_context source="goal">`

// ralphMarker is the slash command the Ralph Loop plugin issues. Matched
// as the full command-name wrapper so the bare "ralph-loop" substring
// (which collides with project directories) does not misclassify.
const ralphMarker = "<command-name>/ralph-loop:ralph-loop</command-name>"

// Classify returns the kinds derivable from a single session's turns and
// tool names, sorted and de-duplicated. orchestrator is never returned
// here (it is edge-dependent). Returns nil when the session is ordinary.
func Classify(turns []session.Turn, toolNames []string) []string {
	var kinds []string

	if isGoal(turns) {
		kinds = append(kinds, KindGoal)
	}
	if slices.Contains(toolNames, "Workflow") {
		kinds = append(kinds, KindWorkflow)
	}
	if isRalphLoop(turns) {
		kinds = append(kinds, KindRalphLoop)
	}

	if len(kinds) == 0 {
		return nil
	}
	sort.Strings(kinds)
	return kinds
}

// isGoal scans every user turn: the goal wrapper re-injects on each turn,
// and the first user turn is often an unrelated preamble (e.g. an
// "# AGENTS.md instructions" block), so checking only the first misses
// real goal sessions.
func isGoal(turns []session.Turn) bool {
	for _, t := range turns {
		if t.Role == "user" && strings.HasPrefix(strings.TrimSpace(t.Content), goalPrefix) {
			return true
		}
	}
	return false
}

func isRalphLoop(turns []session.Turn) bool {
	for _, t := range turns {
		if t.Role == "user" && strings.Contains(t.Content, ralphMarker) {
			return true
		}
	}
	return false
}
