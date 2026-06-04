package panel

import (
	"net/url"
	"strings"
	"testing"
)

func TestResolveSessionsSort(t *testing.T) {
	t.Parallel()
	sort, dir := resolveSessionsSort("", "")
	if sort != "started_at" || dir != "desc" {
		t.Fatalf("default got %q %q", sort, dir)
	}
	sort, dir = resolveSessionsSort("agent", "")
	if sort != "agent" || dir != "asc" {
		t.Fatalf("agent default got %q %q", sort, dir)
	}
	sort, dir = resolveSessionsSort("total_tokens", "asc")
	if sort != "total_tokens" || dir != "asc" {
		t.Fatalf("explicit got %q %q", sort, dir)
	}
}

func TestNextSortURL_threeState_descDefault(t *testing.T) {
	t.Parallel()
	base := url.Values{"q": {"hello"}, "last": {"30d"}}
	activeSort, activeDir := resolveSessionsSort("", "")

	// inactive column -> sort with default dir (no dir param)
	got := nextSortURL(base, "total_tokens", activeSort, activeDir)
	if !strings.Contains(got, "sort=total_tokens") || strings.Contains(got, "dir=") {
		t.Fatalf("first click: %q", got)
	}

	// active default -> reverse
	activeSort, activeDir = resolveSessionsSort("total_tokens", "")
	got = nextSortURL(base, "total_tokens", activeSort, activeDir)
	if !strings.Contains(got, "sort=total_tokens") || !strings.Contains(got, "dir=asc") {
		t.Fatalf("second click: %q", got)
	}

	// active reversed -> clear
	activeSort, activeDir = resolveSessionsSort("total_tokens", "asc")
	got = nextSortURL(base, "total_tokens", activeSort, activeDir)
	if strings.Contains(got, "sort=") || strings.Contains(got, "dir=") {
		t.Fatalf("third click: %q", got)
	}
	if !strings.Contains(got, "q=hello") {
		t.Fatalf("filters preserved: %q", got)
	}
}

func TestNextSortURL_threeState_ascDefault(t *testing.T) {
	t.Parallel()
	base := url.Values{}
	activeSort, activeDir := resolveSessionsSort("", "")

	got := nextSortURL(base, "agent", activeSort, activeDir)
	if !strings.Contains(got, "sort=agent") || strings.Contains(got, "dir=") {
		t.Fatalf("first click: %q", got)
	}

	activeSort, activeDir = resolveSessionsSort("agent", "")
	got = nextSortURL(base, "agent", activeSort, activeDir)
	if !strings.Contains(got, "dir=desc") {
		t.Fatalf("second click: %q", got)
	}

	activeSort, activeDir = resolveSessionsSort("agent", "desc")
	got = nextSortURL(base, "agent", activeSort, activeDir)
	if strings.Contains(got, "sort=") {
		t.Fatalf("third click: %q", got)
	}
}

func TestSortArrow(t *testing.T) {
	t.Parallel()
	if sortArrow("started_at", "desc", "started_at") != "▾" {
		t.Fatal("desc arrow")
	}
	if sortArrow("agent", "asc", "agent") != "▴" {
		t.Fatal("asc arrow")
	}
	if sortArrow("agent", "asc", "project") != "" {
		t.Fatal("inactive column")
	}
}
