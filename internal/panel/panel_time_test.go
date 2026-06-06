package panel

import (
	"testing"
	"time"
)

func TestRelativeTime(t *testing.T) {
	now := time.Date(2026, 6, 6, 12, 0, 0, 0, time.UTC)
	prev := nowFn
	nowFn = func() time.Time { return now }
	t.Cleanup(func() { nowFn = prev })

	if relativeTime(now.Add(-30*time.Second)) != "just now" {
		t.Fatal("expected just now")
	}
	if relativeTime(now.Add(-2*time.Hour)) != "2h ago" {
		t.Fatal("expected 2h ago")
	}
}

func TestWindowLabel(t *testing.T) {
	t.Parallel()
	if windowLabel("365d") != "1y" {
		t.Fatal(windowLabel("365d"))
	}
	if windowLabel("") != "30d" {
		t.Fatal(windowLabel(""))
	}
}
