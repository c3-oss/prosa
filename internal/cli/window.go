package cli

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// dateLayout is the canonical YYYY-MM-DD format used by --since and
// --between. Datetime and RFC3339 are intentionally not supported —
// the question prosa answers ("what did I work on?") is naturally
// day-grained.
const dateLayout = "2006-01-02"

// Window is the resolved time range for a query plus the descriptor
// labels the renderer uses to assemble the context line. Exactly one
// of LastLabel / SinceLabel / BetweenLabel / HeatmapLabel is non-empty
// after a successful ResolveWindow or HeatmapWindow.
type Window struct {
	Since, Until time.Time
	LastLabel    string // "7d" — non-empty iff window came from --last
	SinceLabel   string // "2026-01-01" — non-empty iff --since
	BetweenLabel string // "2026-01-01 and 2026-03-15" — non-empty iff --between
	HeatmapLabel string // "53 weeks" — non-empty iff the fixed heatmap window
}

// ParseSince parses a YYYY-MM-DD date in UTC, returning the start of
// the day. Empty input is rejected (callers should branch on whether
// the flag was passed before calling).
func ParseSince(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, errors.New("empty date")
	}
	t, err := time.ParseInLocation(dateLayout, s, time.UTC)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse %q (expected YYYY-MM-DD): %w", s, err)
	}
	return t, nil
}

// ParseBetween parses "YYYY-MM-DD..YYYY-MM-DD" in UTC and returns
// the inclusive range: start = beginning of the first day, end =
// last nanosecond of the second day. End must be >= start.
func ParseBetween(s string) (time.Time, time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, time.Time{}, errors.New("empty range")
	}
	parts := strings.Split(s, "..")
	if len(parts) != 2 {
		return time.Time{}, time.Time{}, fmt.Errorf("expected YYYY-MM-DD..YYYY-MM-DD, got %q", s)
	}
	a, err := ParseSince(parts[0])
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("start date: %w", err)
	}
	b, err := ParseSince(parts[1])
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("end date: %w", err)
	}
	if b.Before(a) {
		return time.Time{}, time.Time{}, fmt.Errorf("end date %s before start date %s",
			b.Format(dateLayout), a.Format(dateLayout))
	}
	// Inclusive end: bump to the last nanosecond of the second day.
	end := b.Add(24*time.Hour - time.Nanosecond)
	return a, end, nil
}

// ResolveWindow centralizes the time-window decision shared by `prosa`,
// `prosa search`, and `prosa analytics`. Exactly one of --last,
// --since, --between may be active; --last counts as "active" only
// when it was explicitly set (Cobra's Changed check), because its
// default value of "7d" would otherwise mark every invocation as
// providing --last.
func ResolveWindow(cmd *cobra.Command, last, since, between string, now time.Time) (Window, error) {
	set := 0
	lastSet := cmd != nil && cmd.Flags().Changed("last")
	if lastSet {
		set++
	}
	if since != "" {
		set++
	}
	if between != "" {
		set++
	}
	if set > 1 {
		return Window{}, errors.New("--last, --since, and --between are mutually exclusive")
	}

	if between != "" {
		s, u, err := ParseBetween(between)
		if err != nil {
			return Window{}, fmt.Errorf("--between: %w", err)
		}
		return Window{
			Since:        s,
			Until:        u,
			BetweenLabel: s.Format(dateLayout) + " and " + u.Format(dateLayout),
		}, nil
	}
	if since != "" {
		s, err := ParseSince(since)
		if err != nil {
			return Window{}, fmt.Errorf("--since: %w", err)
		}
		return Window{
			Since:      s,
			Until:      now,
			SinceLabel: since,
		}, nil
	}
	d, err := ParseLast(last)
	if err != nil {
		return Window{}, fmt.Errorf("--last: %w", err)
	}
	return Window{
		Since:     now.Add(-d),
		Until:     now,
		LastLabel: last,
	}, nil
}

// WindowDescriptor renders the active window as a complete English
// fragment that slots into empty-state messages: "no sessions <X>"
// where X is the return value. "in the" is included for --last so the
// sentence reads "no sessions in the last 7d" without surrounding glue.
func WindowDescriptor(w Window) string {
	switch {
	case w.BetweenLabel != "":
		return "between " + w.BetweenLabel
	case w.SinceLabel != "":
		return "since " + w.SinceLabel
	case w.HeatmapLabel != "":
		return "in the last " + w.HeatmapLabel
	default:
		return "in the last " + w.LastLabel
	}
}

// LastSegment is the string that slots into the context line's
// "last X" tail. It collapses LastLabel and HeatmapLabel into one
// channel so call sites don't branch on which field is set.
func (w Window) LastSegment() string {
	if w.HeatmapLabel != "" {
		return w.HeatmapLabel
	}
	return w.LastLabel
}

// HeatmapWindow returns the fixed trailing-year window used by the
// heatmap report: 53 weeks aligned to Sunday in UTC (52 prior weeks
// plus the current one). The rightmost column always contains today.
// Canonical spec: docs/panel/screens.md (heatmap).
func HeatmapWindow(now time.Time) Window {
	today := dayStartUTC(now)
	startOfThisWeek := today.AddDate(0, 0, -int(today.Weekday()))
	return Window{
		Since:        startOfThisWeek.AddDate(0, 0, -52*7),
		Until:        now.UTC(),
		HeatmapLabel: "53 weeks",
	}
}

func dayStartUTC(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
}
