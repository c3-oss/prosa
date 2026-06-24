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
