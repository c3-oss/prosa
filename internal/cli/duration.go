package cli

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ParseLast parses window strings like "7d", "12h", "45m".
// Days ("7d") are handled here because time.ParseDuration doesn't understand them.
func ParseLast(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty duration")
	}
	if strings.HasSuffix(s, "d") {
		n, err := strconv.Atoi(strings.TrimSuffix(s, "d"))
		if err != nil {
			return 0, fmt.Errorf("cannot parse %q as a window (try 7d, 12h, 45m)", s)
		}
		d := time.Duration(n) * 24 * time.Hour
		if d <= 0 {
			return 0, fmt.Errorf("duration must be > 0")
		}
		return d, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("cannot parse %q as a window (try 7d, 12h, 45m)", s)
	}
	if d <= 0 {
		return 0, fmt.Errorf("duration must be > 0")
	}
	return d, nil
}
