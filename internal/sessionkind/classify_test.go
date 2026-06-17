package sessionkind

import (
	"reflect"
	"testing"

	"github.com/c3-oss/prosa/pkg/session"
)

func userTurn(content string) session.Turn {
	return session.Turn{Role: "user", Content: content}
}

func TestClassify(t *testing.T) {
	tests := []struct {
		name      string
		turns     []session.Turn
		toolNames []string
		want      []string
	}{
		{
			name: "ordinary session",
			turns: []session.Turn{
				userTurn("fix the bug in main.go"),
				{Role: "assistant", Content: "done"},
			},
			want: nil,
		},
		{
			name:  "goal session",
			turns: []session.Turn{userTurn("  <codex_internal_context source=\"goal\">\nContinue...\n<objective>do X</objective>")},
			want:  []string{KindGoal},
		},
		{
			name: "goal detected in a later user turn (first is AGENTS.md preamble)",
			turns: []session.Turn{
				userTurn("# AGENTS.md instructions for /repo"),
				userTurn("<codex_internal_context source=\"goal\">\n<objective>do X</objective>"),
			},
			want: []string{KindGoal},
		},
		{
			name:      "workflow session",
			turns:     []session.Turn{userTurn("orchestrate this")},
			toolNames: []string{"Read", "Workflow", "Bash"},
			want:      []string{KindWorkflow},
		},
		{
			name:  "ralph loop session",
			turns: []session.Turn{userTurn("<command-name>/ralph-loop:ralph-loop</command-name>\n<command-args></command-args>")},
			want:  []string{KindRalphLoop},
		},
		{
			name:  "bare ralph-loop substring does not classify",
			turns: []session.Turn{userTurn("explore /Users/me/Projects/ralph-loop-governor/README.md")},
			want:  nil,
		},
		{
			name: "goal that also orchestrates via workflow",
			turns: []session.Turn{
				userTurn("<codex_internal_context source=\"goal\">\n<objective>parallelize</objective>"),
			},
			toolNames: []string{"Workflow"},
			want:      []string{KindGoal, KindWorkflow},
		},
		{
			name:      "Workflow as exact name, not substring",
			turns:     []session.Turn{userTurn("hi")},
			toolNames: []string{"WorkflowRunner"},
			want:      nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Classify(tt.turns, tt.toolNames)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Classify() = %v, want %v", got, tt.want)
			}
		})
	}
}
