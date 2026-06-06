package panel

import (
	"fmt"
	"time"
)

var nowFn = time.Now

// relativeTime formats t as a compact relative label (e.g. "12h ago").
func relativeTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := nowFn().Sub(t)
	if d < 0 {
		d = -d
	}
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		m := int(d / time.Minute)
		if m == 1 {
			return "1min ago"
		}
		return fmt.Sprintf("%dmin ago", m)
	case d < 24*time.Hour:
		h := int(d / time.Hour)
		if h == 1 {
			return "1h ago"
		}
		return fmt.Sprintf("%dh ago", h)
	case d < 7*24*time.Hour:
		days := int(d / (24 * time.Hour))
		if days == 1 {
			return "1d ago"
		}
		return fmt.Sprintf("%dd ago", days)
	case d < 30*24*time.Hour:
		w := int(d / (7 * 24 * time.Hour))
		if w == 1 {
			return "1w ago"
		}
		return fmt.Sprintf("%dw ago", w)
	case d < 365*24*time.Hour:
		mo := int(d / (30 * 24 * time.Hour))
		if mo == 1 {
			return "1mo ago"
		}
		return fmt.Sprintf("%dmo ago", mo)
	default:
		y := int(d / (365 * 24 * time.Hour))
		if y == 1 {
			return "1y ago"
		}
		return fmt.Sprintf("%dy ago", y)
	}
}

// windowLabel is the compact label shown on the Window filter button.
func windowLabel(last string) string {
	switch last {
	case "", "30d":
		return "30d"
	case "365d":
		return "1y"
	default:
		return last
	}
}
