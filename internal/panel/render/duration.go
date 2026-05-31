package render

import (
	"fmt"
	"strconv"
	"time"
)

// HumanDuration formats d into a short, human-readable label suitable
// for the sidepanel stats cluster ("18 min", "1h 30m", "4d") and the
// "Worked for …" divider between turn groups. Returns "—" when d <= 0
// so callers can pass StartedAt/LastActivityAt deltas without guarding.
func HumanDuration(d time.Duration) string {
	if d <= 0 {
		return "—"
	}
	if d < time.Minute {
		return strconv.Itoa(int(d.Round(time.Second).Seconds())) + "s"
	}
	if d < time.Hour {
		mins := int(d / time.Minute)
		secs := int((d % time.Minute) / time.Second)
		if mins < 5 && secs > 0 {
			return fmt.Sprintf("%dm %ds", mins, secs)
		}
		return fmt.Sprintf("%dm", mins)
	}
	if d < 24*time.Hour {
		hours := int(d / time.Hour)
		mins := int((d % time.Hour) / time.Minute)
		if mins == 0 {
			return fmt.Sprintf("%dh", hours)
		}
		return fmt.Sprintf("%dh %dm", hours, mins)
	}
	days := int(d / (24 * time.Hour))
	hours := int((d % (24 * time.Hour)) / time.Hour)
	if hours == 0 {
		return fmt.Sprintf("%dd", days)
	}
	return fmt.Sprintf("%dd %dh", days, hours)
}
