package cli

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
)

func TestParseSince(t *testing.T) {
	cases := []struct {
		in      string
		wantErr bool
		want    time.Time
	}{
		{"2026-01-01", false, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
		{"2030-12-31", false, time.Date(2030, 12, 31, 0, 0, 0, 0, time.UTC)},
		{"  2026-05-15  ", false, time.Date(2026, 5, 15, 0, 0, 0, 0, time.UTC)},
		{"", true, time.Time{}},
		{"bad", true, time.Time{}},
		{"2026/01/01", true, time.Time{}},
		{"2026-13-01", true, time.Time{}},
		{"2026-01-32", true, time.Time{}},
	}
	for _, c := range cases {
		got, err := ParseSince(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("ParseSince(%q) = %s, want error", c.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseSince(%q) error: %v", c.in, err)
			continue
		}
		if !got.Equal(c.want) {
			t.Errorf("ParseSince(%q) = %s, want %s", c.in, got, c.want)
		}
	}
}

func TestParseBetween(t *testing.T) {
	cases := []struct {
		in        string
		wantErr   bool
		wantStart time.Time
		wantEnd   time.Time
	}{
		{
			"2026-01-01..2026-01-01", false,
			time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
			time.Date(2026, 1, 1, 23, 59, 59, 999999999, time.UTC),
		},
		{
			"2026-01-01..2026-03-15", false,
			time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
			time.Date(2026, 3, 15, 23, 59, 59, 999999999, time.UTC),
		},
		{"", true, time.Time{}, time.Time{}},
		{"2026-01-01", true, time.Time{}, time.Time{}},
		{"2026-01-01..", true, time.Time{}, time.Time{}},
		{"..2026-01-01", true, time.Time{}, time.Time{}},
		{"2026-01-01..2026-02-15..2026-03-01", true, time.Time{}, time.Time{}},
		{"bad..2026-01-01", true, time.Time{}, time.Time{}},
		{"2026-01-01..bad", true, time.Time{}, time.Time{}},
		{"2026-03-15..2026-01-01", true, time.Time{}, time.Time{}},
	}
	for _, c := range cases {
		start, end, err := ParseBetween(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("ParseBetween(%q) = (%s, %s), want error", c.in, start, end)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseBetween(%q) error: %v", c.in, err)
			continue
		}
		if !start.Equal(c.wantStart) {
			t.Errorf("ParseBetween(%q) start = %s, want %s", c.in, start, c.wantStart)
		}
		if !end.Equal(c.wantEnd) {
			t.Errorf("ParseBetween(%q) end = %s, want %s", c.in, end, c.wantEnd)
		}
	}
}

func TestParseBetweenEndBeforeStartMessage(t *testing.T) {
	_, _, err := ParseBetween("2026-03-15..2026-01-01")
	if err == nil {
		t.Fatal("expected error for end before start")
	}
	if !strings.Contains(err.Error(), "before start") {
		t.Errorf("error message %q should mention 'before start'", err)
	}
}

func TestParseLast(t *testing.T) {
	cases := []struct {
		in      string
		want    time.Duration
		wantErr bool
	}{
		{"7d", 7 * 24 * time.Hour, false},
		{"12h", 12 * time.Hour, false},
		{"45m", 45 * time.Minute, false},
		{"  1d  ", 24 * time.Hour, false},
		{"", 0, true},
		{"abc", 0, true},
		{"1.5d", 0, true},
		{"0d", 0, true},
		{"0s", 0, true},
		{"-1d", 0, true},
		{"-24h", 0, true},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			got, err := ParseLast(c.in)
			if c.wantErr {
				if err == nil {
					t.Fatalf("ParseLast(%q) = %s, want error", c.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseLast(%q) error: %v", c.in, err)
			}
			if got != c.want {
				t.Fatalf("ParseLast(%q) = %s, want %s", c.in, got, c.want)
			}
		})
	}
}

// newWindowCmd returns a cobra command pre-wired with the --last
// flag default so ResolveWindow's Changed() check has something to
// observe.
func newWindowCmd(t *testing.T, args ...string) *cobra.Command {
	t.Helper()
	cmd := &cobra.Command{Use: "test"}
	cmd.Flags().String("last", "7d", "")
	if err := cmd.ParseFlags(args); err != nil {
		t.Fatalf("ParseFlags: %v", err)
	}
	return cmd
}

func TestResolveWindowDefaults(t *testing.T) {
	now := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	cmd := newWindowCmd(t)
	w, err := ResolveWindow(cmd, "7d", "", "", now)
	if err != nil {
		t.Fatalf("ResolveWindow: %v", err)
	}
	if w.LastLabel != "7d" {
		t.Errorf("LastLabel = %q, want 7d", w.LastLabel)
	}
	if w.SinceLabel != "" || w.BetweenLabel != "" {
		t.Errorf("non-Last labels populated: %+v", w)
	}
	if !w.Until.Equal(now) {
		t.Errorf("Until = %s, want %s", w.Until, now)
	}
	if w.Since.Day() != 23 { // 30 - 7
		t.Errorf("Since = %s, expected 7d before now", w.Since)
	}
}

func TestResolveWindowSinceOnly(t *testing.T) {
	now := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	cmd := newWindowCmd(t)
	w, err := ResolveWindow(cmd, "7d", "2026-01-01", "", now)
	if err != nil {
		t.Fatalf("ResolveWindow: %v", err)
	}
	if w.SinceLabel != "2026-01-01" {
		t.Errorf("SinceLabel = %q", w.SinceLabel)
	}
	if w.LastLabel != "" || w.BetweenLabel != "" {
		t.Errorf("other labels populated: %+v", w)
	}
	if !w.Until.Equal(now) {
		t.Errorf("Until = %s, want %s", w.Until, now)
	}
}

func TestResolveWindowBetweenOnly(t *testing.T) {
	now := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	cmd := newWindowCmd(t)
	w, err := ResolveWindow(cmd, "7d", "", "2026-01-01..2026-03-15", now)
	if err != nil {
		t.Fatalf("ResolveWindow: %v", err)
	}
	if w.BetweenLabel != "2026-01-01 and 2026-03-15" {
		t.Errorf("BetweenLabel = %q", w.BetweenLabel)
	}
	if w.LastLabel != "" || w.SinceLabel != "" {
		t.Errorf("other labels populated: %+v", w)
	}
}

func TestResolveWindowMutualExclusion(t *testing.T) {
	now := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name              string
		args              []string
		last, since, btwn string
	}{
		{"last + since (explicit last)", []string{"--last", "7d"}, "7d", "2026-01-01", ""},
		{"last + between (explicit last)", []string{"--last", "7d"}, "7d", "", "2026-01-01..2026-02-01"},
		{"since + between", []string{}, "7d", "2026-01-01", "2026-01-01..2026-02-01"},
		{"all three (explicit last)", []string{"--last", "7d"}, "7d", "2026-01-01", "2026-01-01..2026-02-01"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cmd := newWindowCmd(t, c.args...)
			_, err := ResolveWindow(cmd, c.last, c.since, c.btwn, now)
			if err == nil {
				t.Fatal("expected mutual exclusion error")
			}
			if !strings.Contains(err.Error(), "mutually exclusive") {
				t.Errorf("error %q should mention 'mutually exclusive'", err)
			}
		})
	}
}

func TestResolveWindowDefaultLastDoesNotTriggerExclusion(t *testing.T) {
	// --last was not explicitly set; only --since is provided.
	now := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	cmd := newWindowCmd(t)
	w, err := ResolveWindow(cmd, "7d", "2026-01-01", "", now)
	if err != nil {
		t.Fatalf("ResolveWindow: %v", err)
	}
	if w.SinceLabel == "" {
		t.Error("expected SinceLabel populated")
	}
}

func TestResolveWindowInvalidBetween(t *testing.T) {
	cmd := newWindowCmd(t)
	_, err := ResolveWindow(cmd, "7d", "", "bad", time.Now().UTC())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "--between") {
		t.Errorf("error %q should mention --between", err)
	}
}

func TestResolveWindowInvalidSince(t *testing.T) {
	cmd := newWindowCmd(t)
	_, err := ResolveWindow(cmd, "7d", "bad", "", time.Now().UTC())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "--since") {
		t.Errorf("error %q should mention --since", err)
	}
}

func TestWindowDescriptor(t *testing.T) {
	cases := []struct {
		w    Window
		want string
	}{
		{Window{LastLabel: "7d"}, "in the last 7d"},
		{Window{SinceLabel: "2026-01-01"}, "since 2026-01-01"},
		{Window{BetweenLabel: "2026-01-01 and 2026-03-15"}, "between 2026-01-01 and 2026-03-15"},
	}
	for _, c := range cases {
		if got := WindowDescriptor(c.w); got != c.want {
			t.Errorf("WindowDescriptor(%+v) = %q, want %q", c.w, got, c.want)
		}
	}
}

// nilCobraCmdGuard makes sure ResolveWindow doesn't panic when cmd is
// nil — the helper might one day be reused from contexts that don't
// have a cobra command at hand.
func TestResolveWindowNilCmd(t *testing.T) {
	now := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	w, err := ResolveWindow(nil, "14d", "", "", now)
	if err != nil {
		t.Fatalf("ResolveWindow: %v", err)
	}
	if w.LastLabel != "14d" {
		t.Errorf("LastLabel = %q, want 14d", w.LastLabel)
	}
}

// sanity guard against accidental import removal of errors pkg.
var _ = errors.New
