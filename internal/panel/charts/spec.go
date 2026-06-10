// Package charts builds chart specifications for the panel's dashboard
// cards. A Spec is serialized to a JSON island in the page and rendered
// client-side by Frappe Charts (a vendored, zero-dependency SVG charting
// library; see internal/panel/assets/charts-init.js and
// docs/architecture/panel.md). Colors are not baked in here: the spec
// carries series order, and charts-init.js resolves the categorical
// palette from the --chart-* CSS tokens so a light/dark theme swap
// recolors every chart with no Go change.
//
// This replaced an earlier server-side inline-SVG renderer. Charts now
// animate and expose hover tooltips / interactive axes for free; the
// trade-off is that rendering is client-side, so the unit tests assert
// the JSON shape rather than byte-identical SVG.
package charts

import (
	"bytes"
	"encoding/json"
	"html/template"
)

// Spec is one chart. Type is a Frappe Charts chart type: "bar", "line",
// "donut", or "axis-mixed". For donut/pie, Labels are the slice labels
// and Datasets holds a single dataset whose Values are the slice values.
// For axis charts, Labels are the x categories and each Dataset is a
// series.
type Spec struct {
	Type        string    `json:"type"`
	Labels      []string  `json:"labels,omitempty"`
	Datasets    []Dataset `json:"datasets"`
	Stacked     bool      `json:"stacked,omitempty"`     // bar: stack the datasets
	RegionFill  bool      `json:"regionFill,omitempty"`  // line: fill under the line (area look)
	ValuePrefix string    `json:"valuePrefix,omitempty"` // tooltip/axis prefix, e.g. "$"
	ValueSuffix string    `json:"valueSuffix,omitempty"` // tooltip/axis suffix, e.g. "%", " tokens"
	Height      int       `json:"height,omitempty"`      // chart draw height in px
}

// Dataset is one series of a chart. ChartType overrides the chart's Type
// for this series (used by "axis-mixed" to mix bars and a line); empty
// means inherit the chart Type.
type Dataset struct {
	Name      string    `json:"name,omitempty"`
	Values    []float64 `json:"values"`
	ChartType string    `json:"chartType,omitempty"` // "bar" | "line"
}

// HasData reports whether the spec carries at least one non-empty series,
// so templates can guard the chart container + JSON island.
func (s Spec) HasData() bool {
	for _, d := range s.Datasets {
		if len(d.Values) > 0 {
			return true
		}
	}
	return false
}

// JSON renders the spec as a compact JSON literal safe to embed inside a
// <script type="application/json"> island. encoding/json's HTML escaping
// turns "<", ">", "&" into \u00xx, so a stray "</script>" in any label
// can't close the tag; charts-init.js reads the island with
// JSON.parse(textContent), never eval. The result is template.JS so
// html/template emits it verbatim.
func (s Spec) JSON() template.JS {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(true)
	if err := enc.Encode(s); err != nil {
		return template.JS("{}")
	}
	return template.JS(bytes.TrimRight(buf.Bytes(), "\n")) //nolint:gosec // HTML-escaped JSON; see doc comment
}
