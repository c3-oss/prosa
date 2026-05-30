package cli

import (
	"runtime"
	"strings"
	"testing"
)

func TestDetectAgentsListsAll(t *testing.T) {
	reports := detectAgents()
	if len(reports) == 0 {
		t.Fatal("expected at least one importer registered")
	}
	names := make(map[string]bool)
	for _, r := range reports {
		names[r.name] = true
	}
	for _, expected := range []string{"claude-code", "codex", "cursor", "gemini"} {
		if !names[expected] {
			t.Errorf("expected %q in detected agents, got %v", expected, names)
		}
	}
}

func TestRenderAgentSummaryMixed(t *testing.T) {
	reports := []agentReport{
		{name: "claude-code", foundAny: true},
		{name: "codex", foundAny: false},
	}
	summary := renderAgentSummary(reports)
	if !strings.Contains(summary, "claude-code") {
		t.Errorf("expected claude-code in summary, got %q", summary)
	}
	if !strings.Contains(summary, "codex") {
		t.Errorf("expected codex in summary, got %q", summary)
	}
}

func TestRenderAgentSummaryEmpty(t *testing.T) {
	if got := renderAgentSummary(nil); !strings.Contains(got, "none") {
		t.Errorf("empty reports expected to mention 'none', got %q", got)
	}
}

func TestSchedulerKindMatchesGOOS(t *testing.T) {
	got := schedulerKind()
	switch runtime.GOOS {
	case "darwin":
		if got != "LaunchAgent" {
			t.Errorf("schedulerKind on darwin = %q, want LaunchAgent", got)
		}
	case "linux":
		if got != "systemd timer" {
			t.Errorf("schedulerKind on linux = %q, want systemd timer", got)
		}
	default:
		if got != runtime.GOOS {
			t.Errorf("schedulerKind on %s = %q, want %s", runtime.GOOS, got, runtime.GOOS)
		}
	}
}
