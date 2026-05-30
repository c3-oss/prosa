package render

import (
	"fmt"
	"time"
)

// DayHeader returns the relative label INTENT.md §8 specifies for the
// timeline grouping header.
//
//	0 days ago:        "Today"
//	1 day ago:         "Yesterday"
//	2..6 days ago:     "N days ago"
//	7..30 days ago:    weekday name (e.g. "Wednesday")
//	more than 30 days: absolute date "Jan 02"
//
// The comparison is done on day boundaries in t's timezone, not via
// straight Sub(), so a session at 23:55 yesterday and one at 00:05 today
// land under separate headers as users expect.
func DayHeader(t, now time.Time) string {
	tDay := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
	nDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	days := int(nDay.Sub(tDay).Hours() / 24)
	switch {
	case days <= 0:
		return "Today"
	case days == 1:
		return "Yesterday"
	case days < 7:
		return fmt.Sprintf("%d days ago", days)
	case days <= 30:
		return t.Weekday().String()
	default:
		return t.Format("Jan 02")
	}
}
