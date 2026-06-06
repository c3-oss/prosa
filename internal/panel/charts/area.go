package charts

import (
	"fmt"
	"html/template"
	"strings"
)

// Point is one sample in an Area chart.
type Point struct {
	Label string
	Value float64
}

// AreaOpts configures Area. Zero values fall back to sensible defaults.
type AreaOpts struct {
	Width      int    // viewBox width, default 520
	Height     int    // viewBox height, default 140
	Class      string // root element class, default "area-chart"
	UnitSuffix string // appended to each point value in its <title>
	PeakColor  string // peak marker fill, default "var(--accent)"
}

// Area renders a line + soft-fill chart over the given points (e.g. activity
// by hour of day). The peak point gets a highlighted marker carrying a
// <title> for hover/a11y. The line color is currentColor so the card
// controls it via CSS; the fill is --accent-soft. With no points it renders
// an empty canvas; with all-zero values it renders a flat baseline.
func Area(points []Point, opts AreaOpts) template.HTML {
	w := opts.Width
	if w <= 0 {
		w = 520
	}
	h := opts.Height
	if h <= 0 {
		h = 140
	}
	class := opts.Class
	if class == "" {
		class = "area-chart"
	}
	peakColor := opts.PeakColor
	if peakColor == "" {
		peakColor = "var(--accent)"
	}

	var b strings.Builder
	fmt.Fprintf(&b, `<svg class="%s" viewBox="0 0 %d %d" width="%d" height="%d" preserveAspectRatio="none" role="img">`,
		template.HTMLEscapeString(class), w, h, w, h)
	if len(points) == 0 {
		b.WriteString(`</svg>`)
		return template.HTML(b.String())
	}

	const padTop, padBottom = 8.0, 8.0
	plotH := float64(h) - padTop - padBottom
	if plotH < 1 {
		plotH = 1
	}

	var max float64
	peakIdx := 0
	for i, p := range points {
		if p.Value > max {
			max = p.Value
			peakIdx = i
		}
	}

	n := len(points)
	xAt := func(i int) float64 {
		if n == 1 {
			return float64(w) / 2
		}
		return float64(i) / float64(n-1) * float64(w)
	}
	yAt := func(v float64) float64 {
		if max <= 0 {
			return padTop + plotH
		}
		return padTop + (1-v/max)*plotH
	}

	var line strings.Builder
	for i, p := range points {
		cmd := "L"
		if i == 0 {
			cmd = "M"
		}
		fmt.Fprintf(&line, "%s%s,%s ", cmd, num(xAt(i)), num(yAt(p.Value)))
	}
	linePath := strings.TrimSpace(line.String())

	baseline := padTop + plotH
	fill := linePath + fmt.Sprintf(" L%s,%s L%s,%s Z",
		num(xAt(n-1)), num(baseline), num(xAt(0)), num(baseline))

	fmt.Fprintf(&b, `<path d="%s" fill="var(--accent-soft)" stroke="none"/>`, fill)
	fmt.Fprintf(&b, `<path d="%s" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`, linePath)

	if max > 0 {
		p := points[peakIdx]
		title := fmt.Sprintf("%s: %s%s", p.Label, num(p.Value), opts.UnitSuffix)
		fmt.Fprintf(&b, `<circle cx="%s" cy="%s" r="3.5" fill="%s"><title>%s</title></circle>`,
			num(xAt(peakIdx)), num(yAt(p.Value)), peakColor, template.HTMLEscapeString(title))
	}

	b.WriteString(`</svg>`)
	return template.HTML(b.String())
}
