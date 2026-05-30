package render

import "time"

// ActiveThreshold is the cutoff for considering a session "live" per
// INTENT.md §4. Fixed at 10 minutes in the MVP — no per-agent or
// per-user knob until lived experience says otherwise.
const ActiveThreshold = 10 * time.Minute

// IsActive returns true when the most recent activity in the session
// happened within the threshold window. Centralized so the rule lives in
// exactly one place.
func IsActive(lastActivityAt, now time.Time) bool {
	return now.Sub(lastActivityAt) < ActiveThreshold
}
