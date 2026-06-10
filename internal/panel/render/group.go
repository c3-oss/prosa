package render

import (
	"fmt"
	"html/template"
	"sort"
	"strings"
	"time"
)

// Turn is the render-ready shape for one canonical turn. Mirrors the
// fields the sidepanel template needs without dragging in the proto
// types. Body is pre-rendered HTML.
//
// User turns also carry a structured UserExtras pointer when the
// content was wrapped in boilerplate (`<command-name>`,
// `<system-reminder>`, etc.). The template renders these as discrete
// chips / disclosure details so the bubble body stays focused on the
// human-authored prompt. Nil for non-user turns or for bare prompts
// with no wrappers.
type Turn struct {
	Role       string
	Kind       string
	ToolName   string
	Ts         time.Time
	Body       template.HTML
	UserExtras *UserExtras
}

// UserExtras mirrors the renderable parts of sessiontext.UserMessage
// without exposing that type through the template.
type UserExtras struct {
	Command                 string
	CommandArgs             string
	CommandMessage          string
	Reminders               []string
	EnvContext              string
	Instructions            string
	CollaborationMode       string
	PermissionsInstructions string
	LocalCommandCaveat      string
	LocalCommandStdout      string
	LocalCommandStderr      string
}

// HasDetails reports whether any disclosure block (reminders, stdout,
// env_context, …) needs to be rendered below the bubble body.
func (e *UserExtras) HasDetails() bool {
	if e == nil {
		return false
	}
	return len(e.Reminders) > 0 || e.EnvContext != "" || e.Instructions != "" ||
		e.CollaborationMode != "" || e.PermissionsInstructions != "" ||
		e.LocalCommandCaveat != "" || e.LocalCommandStdout != "" ||
		e.LocalCommandStderr != ""
}

// TurnGroup is one renderable block in the transcript. Either:
//   - Kind == "single"          → Turn is set, single bubble.
//   - Kind == "tool-group"      → Tools and Summary set, collapsible
//     run of consecutive tool_result turns.
//   - Kind == "thinking-group"  → Tools and Summary set, collapsible
//     run of consecutive thinking turns.
//   - Kind == "divider"         → Summary holds a "Worked for …"
//     label inserted between turns separated by a meaningful time
//     gap (see DividerThreshold).
type TurnGroup struct {
	Kind    string
	Turn    Turn
	Tools   []Turn
	Summary string
}

// DividerThreshold is the minimum gap between two surrounding
// non-grouped turns before GroupTurns inserts a "Worked for …"
// divider. 30 s skips the rapid-fire back-and-forth common to a
// real session and only surfaces the genuine pauses (long agent
// processing, human stepping away).
const DividerThreshold = 30 * time.Second

// GroupTurns walks in in order, coalescing maximal runs of
// Role=="tool" into one TurnGroup{Kind:"tool-group"} and maximal
// runs of Kind=="thinking" into TurnGroup{Kind:"thinking-group"};
// everything else stays as TurnGroup{Kind:"single"}. The original
// order is preserved.
//
// When the gap between two consecutive turns exceeds
// DividerThreshold (30s), an additional TurnGroup{Kind:"divider",
// Summary:"Worked for 2m 14s"} is inserted between them. Both turns
// must have a non-zero Ts for the divider to fire — zero-timestamp
// fixtures (and test inputs) stay divider-free.
func GroupTurns(in []Turn) []TurnGroup {
	if len(in) == 0 {
		return nil
	}
	out := make([]TurnGroup, 0, len(in))
	var pendingTools []Turn
	var pendingThinking []Turn
	var lastTs time.Time

	flushTools := func() {
		if len(pendingTools) == 0 {
			return
		}
		out = append(out, TurnGroup{
			Kind:    "tool-group",
			Tools:   pendingTools,
			Summary: toolGroupSummary(pendingTools),
		})
		pendingTools = nil
	}
	flushThinking := func() {
		if len(pendingThinking) == 0 {
			return
		}
		out = append(out, TurnGroup{
			Kind:    "thinking-group",
			Tools:   pendingThinking,
			Summary: thinkingGroupSummary(pendingThinking),
		})
		pendingThinking = nil
	}

	for _, t := range in {
		// Check before adding to a pending bucket so the divider sits
		// between groups, not inside a coalesced run.
		if !lastTs.IsZero() && !t.Ts.IsZero() {
			gap := t.Ts.Sub(lastTs)
			if gap >= DividerThreshold {
				flushTools()
				flushThinking()
				out = append(out, TurnGroup{
					Kind:    "divider",
					Summary: "Worked for " + HumanDuration(gap),
				})
			}
		}
		switch {
		case t.Kind == "thinking":
			flushTools()
			pendingThinking = append(pendingThinking, t)
		case t.Role == "tool":
			flushThinking()
			pendingTools = append(pendingTools, t)
		default:
			flushTools()
			flushThinking()
			out = append(out, TurnGroup{Kind: "single", Turn: t})
		}
		if !t.Ts.IsZero() {
			lastTs = t.Ts
		}
	}
	flushTools()
	flushThinking()
	return out
}

// thinkingGroupSummary returns the label for the collapsed thinking block.
func thinkingGroupSummary(in []Turn) string {
	if len(in) <= 1 {
		return "Processed"
	}
	return fmt.Sprintf("Processed (%d steps)", len(in))
}

// toolGroupSummary builds "Read ×3 · Bash ×1" from the tool turns in
// a group. Empty ToolName falls into a generic "tool" bucket.
func toolGroupSummary(in []Turn) string {
	if len(in) == 0 {
		return ""
	}
	counts := make(map[string]int, len(in))
	for _, t := range in {
		name := t.ToolName
		if name == "" {
			name = "tool"
		}
		counts[name]++
	}
	names := make([]string, 0, len(counts))
	for n := range counts {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool {
		if counts[names[i]] == counts[names[j]] {
			return names[i] < names[j]
		}
		return counts[names[i]] > counts[names[j]]
	})
	parts := make([]string, 0, len(names))
	for _, n := range names {
		parts = append(parts, fmt.Sprintf("%s ×%d", n, counts[n]))
	}
	return strings.Join(parts, " · ")
}
