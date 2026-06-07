package charts

import (
	"fmt"
	"html/template"
	"math"
	"strings"
)

// Slice is one donut segment.
type Slice struct {
	Label string
	Value float64
}

// DonutOpts configures Donut. Zero values fall back to sensible defaults.
type DonutOpts struct {
	Size        int    // square viewBox edge, default 180
	Class       string // root element class, default "donut"
	CenterLabel string // big text in the hole (e.g. "$12.34")
	CenterSub   string // small text under it (e.g. "spend")
	UnitSuffix  string // appended to each slice value in its <title>
}

// donutPalette cycles accent→text-3 tones, all token-based so theming lives
// in tokens.css (cf. docs/panel/components.md §Donut).
var donutPalette = []string{
	"var(--accent)",
	"color-mix(in srgb, var(--accent) 65%, var(--text-3))",
	"color-mix(in srgb, var(--accent) 35%, var(--text-3))",
	"var(--text-3)",
	"color-mix(in srgb, var(--text-3) 55%, transparent)",
}

// PaletteColor returns the donut segment color for index i (cycling). A
// legend rendered outside the SVG uses this so its dots match the segments.
func PaletteColor(i int) string {
	n := len(donutPalette)
	return donutPalette[((i%n)+n)%n]
}

// Donut renders a percentage-distribution donut for the Home cost-per-model
// card. Segments are drawn as a thick stroked circle with stroke-dasharray
// (no arc-path rounding quirks → deterministic). Slices with non-positive
// values are dropped; with no positive slices it renders just the empty
// track ring plus any center text.
func Donut(slices []Slice, opts DonutOpts) template.HTML {
	size := opts.Size
	if size <= 0 {
		size = 180
	}
	class := opts.Class
	if class == "" {
		class = "donut"
	}
	c := float64(size) / 2
	r := float64(size) * 0.34 // band centerline radius
	stroke := float64(size) * 0.18
	circ := 2 * math.Pi * r

	clean := make([]Slice, 0, len(slices))
	var total float64
	for _, s := range slices {
		if s.Value > 0 {
			clean = append(clean, s)
			total += s.Value
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, `<svg class="%s" viewBox="0 0 %d %d" width="%d" height="%d" role="img">`,
		template.HTMLEscapeString(class), size, size, size, size)

	// Track ring under the segments.
	fmt.Fprintf(&b, `<circle cx="%s" cy="%s" r="%s" fill="none" stroke="var(--bg-elev-2)" stroke-width="%s"/>`,
		num(c), num(c), num(r), num(stroke))

	// Segments, clockwise from 12 o'clock.
	offset := 0.0
	for i, s := range clean {
		frac := s.Value / total
		dash := frac * circ
		color := donutPalette[i%len(donutPalette)]
		title := fmt.Sprintf("%s: %s%s (%s%%)", s.Label, num(s.Value), opts.UnitSuffix, num(frac*100))
		fmt.Fprintf(&b,
			`<circle cx="%s" cy="%s" r="%s" fill="none" stroke="%s" stroke-width="%s" `+
				`stroke-dasharray="%s %s" stroke-dashoffset="%s" transform="rotate(-90 %s %s)">`+
				`<title>%s</title></circle>`,
			num(c), num(c), num(r), color, num(stroke),
			num(dash), num(circ-dash), num(-offset),
			num(c), num(c), template.HTMLEscapeString(title))
		offset += dash
	}

	// Center text.
	labelY := c
	if opts.CenterLabel != "" {
		if opts.CenterSub != "" {
			labelY = c - float64(size)*0.03
		}
		fmt.Fprintf(&b,
			`<text x="%s" y="%s" text-anchor="middle" dominant-baseline="central" class="donut-center" fill="var(--text-1)">%s</text>`,
			num(c), num(labelY), template.HTMLEscapeString(opts.CenterLabel))
	}
	if opts.CenterSub != "" {
		fmt.Fprintf(&b,
			`<text x="%s" y="%s" text-anchor="middle" dominant-baseline="central" class="donut-center-sub" fill="var(--text-3)">%s</text>`,
			num(c), num(c+float64(size)*0.12), template.HTMLEscapeString(opts.CenterSub))
	}

	b.WriteString(`</svg>`)
	return template.HTML(b.String())
}
