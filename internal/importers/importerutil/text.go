package importerutil

import (
	"strings"
	"time"
	"unicode/utf8"
)

func ParseRFC3339(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC(), true
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), true
	}
	return time.Time{}, false
}

func TruncatePreview(s string) string {
	if s == "" {
		return ""
	}
	lines := strings.Split(s, "\n")
	truncated := false
	if len(lines) > ToolPreviewMaxLines {
		lines = lines[:ToolPreviewMaxLines]
		truncated = true
	}
	out := strings.Join(lines, "\n")
	if len(out) > ToolPreviewMaxBytes {
		out = truncateUTF8(out, ToolPreviewMaxBytes)
		truncated = true
	}
	if truncated {
		out += "\n…"
	}
	return out
}

func truncateUTF8(s string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(s) <= maxBytes {
		return s
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
