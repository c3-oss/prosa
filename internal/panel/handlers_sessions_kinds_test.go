package panel

import (
	"net/url"
	"strings"
	"testing"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

func TestBuildSessionRowCarriesKinds(t *testing.T) {
	u, _ := url.Parse("/sessions?last=30d")
	row := buildSessionRow(&prosav1.Session{
		Id:    "s1",
		Agent: "codex",
		Kinds: []string{"goal", "orchestrator"},
	}, u, nil)
	if got := strings.Join(row.Kinds, ","); got != "goal,orchestrator" {
		t.Fatalf("row.Kinds = %q, want goal,orchestrator", got)
	}
}

func TestBuildSessionsActiveFiltersIncludesKind(t *testing.T) {
	q := url.Values{"kind": {"goal"}, "last": {"30d"}}
	filters := buildSessionsActiveFilters(q, "", "30d", "30d", nil, nil, nil, nil, []string{"goal"})
	var found bool
	for _, f := range filters {
		if f.Label == "Kind" && f.Value == "goal" {
			found = true
			if !strings.Contains(f.RemoveURL, "/sessions") {
				t.Fatalf("remove URL should target /sessions, got %q", f.RemoveURL)
			}
		}
	}
	if !found {
		t.Fatal("expected a Kind=goal active filter chip")
	}
}

func TestKindBadgeRendersColoredPill(t *testing.T) {
	html := string(kindBadge("ralph-loop"))
	if !strings.Contains(html, `data-kind="ralph-loop"`) {
		t.Fatalf("badge missing data-kind: %q", html)
	}
	if !strings.Contains(html, "ralph") {
		t.Fatalf("badge missing short label: %q", html)
	}
	if kindBadge("") != "" {
		t.Fatal("empty kind should render nothing")
	}
}
