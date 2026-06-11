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
			return 0, fmt.Errorf("parse days %q: %w", s, err)
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("parse duration %q (try forms like 7d, 12h, 45m): %w", s, err)
	}
	return d, nil
}
