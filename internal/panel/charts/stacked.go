package charts

import (
	"fmt"
	"html/template"
	"strings"
)

// Series is one stacked band across every column of a StackedColumns
// chart. Values must align with the labels slice; missing trailing
// values count as zero.
type Series struct {
	Name   string
	Values []float64
}

// StackedOpts configures StackedColumns. Zero values fall back to
// sensible defaults.
type StackedOpts struct {
	Width         int       // viewBox width, default 520
	Height        int       // viewBox height, default 140
	Class         string    // root element class, default "stacked-chart"
	UnitSuffix    string    // appended to each segment value in its <title>
	Normalize     bool      // scale every column to 100% (share-of-total view)
	Overlay       []float64 // optional line on its own max-scale (e.g. cumulative)
	OverlaySuffix string    // appended to the overlay end-marker <title>
}

// StackedColumns renders one column per label with stacked segments,
// one per series, colored via PaletteColor so an HTML legend rendered
// outside the SVG matches. Used by the Home daily-activity trend
// (series per agent), the Insights spend-per-day card (single series +
// cumulative Overlay), and the Insights model-share card (Normalize).
// Non-positive segment values render no rect; with no labels it renders
// an empty canvas.
func StackedColumns(labels []string, series []Series, opts StackedOpts) template.HTML {
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
		class = "stacked-chart"
	}

	var b strings.Builder
	fmt.Fprintf(&b, `<svg class="%s" viewBox="0 0 %d %d" width="%d" height="%d" preserveAspectRatio="none" role="img">`,
		template.HTMLEscapeString(class), w, h, w, h)
	if len(labels) == 0 {
		b.WriteString(`</svg>`)
		return template.HTML(b.String())
	}

	const padTop, padBottom = 8.0, 8.0
	plotH := float64(h) - padTop - padBottom
	if plotH < 1 {
		plotH = 1
	}
	baseline := padTop + plotH

	at := func(s Series, i int) float64 {
		if i >= len(s.Values) || s.Values[i] <= 0 {
			return 0
		}
		return s.Values[i]
	}

	totals := make([]float64, len(labels))
	var maxTotal float64
	for i := range labels {
		for _, s := range series {
			totals[i] += at(s, i)
		}
		if totals[i] > maxTotal {
			maxTotal = totals[i]
		}
	}

	n := len(labels)
	slot := float64(w) / float64(n)
	colW := slot * 0.8
	centerAt := func(i int) float64 { return float64(i)*slot + slot/2 }

	for i, label := range labels {
		scale := maxTotal
		if opts.Normalize {
			scale = totals[i]
		}
		if scale <= 0 {
			continue
		}
		x := float64(i)*slot + slot*0.1
		y := baseline
		for si, s := range series {
			v := at(s, i)
			if v <= 0 {
				continue
			}
			segH := v / scale * plotH
			y -= segH
			title := fmt.Sprintf("%s · %s: %s%s", label, s.Name, num(v), opts.UnitSuffix)
			if opts.Normalize && totals[i] > 0 {
				title += fmt.Sprintf(" (%s%%)", num(v/totals[i]*100))
			}
			fmt.Fprintf(&b, `<rect x="%s" y="%s" width="%s" height="%s" fill="%s"><title>%s</title></rect>`,
				num(x), num(y), num(colW), num(segH), PaletteColor(si), template.HTMLEscapeString(title))
		}
	}

	if len(opts.Overlay) > 0 {
		var overlayMax float64
		for _, v := range opts.Overlay {
			if v > overlayMax {
				overlayMax = v
			}
		}
		if overlayMax > 0 {
			yAt := func(v float64) float64 {
				if v < 0 {
					v = 0
				}
				return padTop + (1-v/overlayMax)*plotH
			}
			pts := min(len(opts.Overlay), n)
			var line strings.Builder
			for i := range pts {
				cmd := "L"
				if i == 0 {
					cmd = "M"
				}
				fmt.Fprintf(&line, "%s%s,%s ", cmd, num(centerAt(i)), num(yAt(opts.Overlay[i])))
			}
			fmt.Fprintf(&b, `<path d="%s" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
				strings.TrimSpace(line.String()))
			last := pts - 1
			title := fmt.Sprintf("%s: %s%s", labels[last], num(opts.Overlay[last]), opts.OverlaySuffix)
			fmt.Fprintf(&b, `<circle cx="%s" cy="%s" r="3.5" fill="var(--accent)"><title>%s</title></circle>`,
				num(centerAt(last)), num(yAt(opts.Overlay[last])), template.HTMLEscapeString(title))
		}
	}

	b.WriteString(`</svg>`)
	return template.HTML(b.String())
}
