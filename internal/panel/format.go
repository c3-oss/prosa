package panel

import (
	"math"
	"strconv"
	"strings"
)

func parsePanelInt(s string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return n
}

func formatPanelInt(n int64) string {
	sign := ""
	if n < 0 {
		sign = "-"
		n = -n
	}
	s := strconv.FormatInt(n, 10)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return sign + s
}

// formatTokensCompact abbreviates large token counts for the Sessions table
// (e.g. 1.2k, 3.4m). Values under 1000 stay exact. One decimal is shown
// unless it is .0; rounding rolls up to the next unit at 1000 (999990 → 1m).
func formatTokensCompact(n int64) string {
	sign := ""
	if n < 0 {
		sign = "-"
		n = -n
	}
	if n < 1000 {
		return sign + strconv.FormatInt(n, 10)
	}
	type unit struct {
		div float64
		suf string
	}
	units := []unit{{1e3, "k"}, {1e6, "m"}, {1e9, "b"}}
	idx := 0
	if n >= 1_000_000_000 {
		idx = 2
	} else if n >= 1_000_000 {
		idx = 1
	}
	for idx < len(units) {
		value := float64(n) / units[idx].div
		rounded := math.Round(value*10) / 10
		if rounded < 1000 || idx == len(units)-1 {
			return sign + formatCompactDecimal(rounded) + units[idx].suf
		}
		idx++
	}
	value := float64(n) / units[len(units)-1].div
	rounded := math.Round(value*10) / 10
	return sign + formatCompactDecimal(rounded) + units[len(units)-1].suf
}

func formatCompactDecimal(v float64) string {
	s := strconv.FormatFloat(v, 'f', 1, 64)
	if strings.HasSuffix(s, ".0") {
		return strings.TrimSuffix(s, ".0")
	}
	return s
}

// displayModel turns a raw model id into a compact, human label for display.
// Presentation only — callers keep the raw id for links, filters, and map
// keys. Examples:
//
//	claude-opus-4-8            → "Opus 4.8"
//	claude-sonnet-4-6          → "Sonnet 4.6"
//	claude-haiku-4-5-20251001  → "Haiku 4.5"   (trailing date stamp dropped)
//	claude-3-5-sonnet          → "Sonnet 3.5"  (older ordering)
//	gpt-5.5                    → "GPT-5.5"
//	gpt-5.3-codex              → "GPT-5.3 Codex"
//	gemini-2.5-pro             → "Gemini 2.5 Pro"
//	"" / "(none)"              → "(none)"
func displayModel(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" || s == "(none)" {
		return "(none)"
	}
	low := strings.ToLower(s)

	switch {
	case strings.HasPrefix(low, "claude-"):
		parts := strings.Split(s[len("claude-"):], "-")
		if n := len(parts); n > 1 && isDateStamp(parts[n-1]) {
			parts = parts[:n-1]
		}
		tier := ""
		ver := make([]string, 0, len(parts))
		for _, p := range parts {
			switch strings.ToLower(p) {
			case "opus", "sonnet", "haiku":
				tier = titleWord(p)
			default:
				ver = append(ver, p)
			}
		}
		if tier == "" {
			return titleWords(s[len("claude-"):])
		}
		if len(ver) == 0 {
			return tier
		}
		return tier + " " + strings.Join(ver, ".")

	case strings.HasPrefix(low, "gpt-"):
		segs := strings.SplitN(s[len("gpt-"):], "-", 2)
		out := "GPT-" + segs[0]
		if len(segs) == 2 && segs[1] != "" {
			out += " " + titleWords(segs[1])
		}
		return out

	case strings.HasPrefix(low, "gemini-"):
		return "Gemini " + titleWords(s[len("gemini-"):])
	}

	return titleWords(s)
}

// isDateStamp reports whether s is an 8-digit YYYYMMDD-style suffix.
func isDateStamp(s string) bool {
	if len(s) != 8 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// titleWord upper-cases the first rune of a single word and lower-cases the
// rest ("opus" → "Opus"); version-like tokens with a leading digit pass
// through unchanged.
func titleWord(s string) string {
	if s == "" {
		return s
	}
	if s[0] >= '0' && s[0] <= '9' {
		return s
	}
	return strings.ToUpper(s[:1]) + strings.ToLower(s[1:])
}

// titleWords splits on dashes/spaces and title-cases each word, upper-casing
// the few acronyms we render ("gpt" → "GPT"). Used for vendor suffixes and
// the unknown-vendor fallback.
func titleWords(s string) string {
	fields := strings.FieldsFunc(s, func(r rune) bool { return r == '-' || r == ' ' })
	for i, f := range fields {
		switch strings.ToLower(f) {
		case "gpt":
			fields[i] = "GPT"
		default:
			fields[i] = titleWord(f)
		}
	}
	return strings.Join(fields, " ")
}

// formatUSD renders a dollar amount with thousands separators and two
// decimals (17436.35 → "$17,436.35"), so spend reads consistently with the
// comma-grouped integer counts. Small values round-trip unchanged ("$5.71").
func formatUSD(v float64) string {
	sign := ""
	if v < 0 {
		sign = "-"
		v = -v
	}
	cents := int64(math.Round(v * 100))
	whole := cents / 100
	frac := cents % 100
	fracStr := strconv.FormatInt(frac, 10)
	if len(fracStr) < 2 {
		fracStr = "0" + fracStr
	}
	return sign + "$" + formatPanelInt(whole) + "." + fracStr
}
