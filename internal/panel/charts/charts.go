// Package charts renders small, deterministic inline-SVG charts for the
// panel's server-rendered Home cards. Every helper returns template.HTML and
// uses only CSS design tokens for color, so the same input always produces
// byte-identical output (covered by golden tests) and theming stays in
// tokens.css. There is no client-side charting library — see
// docs/panel/components.md.
package charts

import (
	"strconv"
	"strings"
)

// num formats an SVG coordinate deterministically: fixed 2 decimals with
// trailing zeros (and the dot) trimmed, so golden files stay byte-stable
// across platforms. Normalizes "-0" to "0".
func num(v float64) string {
	s := strconv.FormatFloat(v, 'f', 2, 64)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(s, "0")
		s = strings.TrimRight(s, ".")
	}
	if s == "-0" {
		s = "0"
	}
	return s
}
