package handlers

import (
	"strings"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"
)

func joinAnd(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += " AND "
		}
		out += p
	}
	return out
}

// scanSessionRow scans the canonical session select columns into a
func derefInt64(v *int64) int64 {
	if v == nil {
		return 0
	}
	return *v
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return pgText(s)
}

func pgText(s string) string {
	return strings.ReplaceAll(s, "\x00", " ")
}

func tsToTime(ts *timestamppb.Timestamp) time.Time {
	if ts == nil {
		return time.Time{}
	}
	return ts.AsTime()
}
