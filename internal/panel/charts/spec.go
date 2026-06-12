// Package charts builds chart specs serialized to a JSON island and
// rendered client-side by Frappe Charts (see assets/charts-init.js).
package charts

import (
	"bytes"
	"encoding/json"
	"html/template"
)

// Spec is one chart. Type is a Frappe Charts type: "bar", "line",
// "donut", or "axis-mixed".
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

// Dataset is one series; ChartType overrides the chart Type for
// "axis-mixed", empty inherits it.
type Dataset struct {
	Name      string    `json:"name,omitempty"`
	Values    []float64 `json:"values"`
	ChartType string    `json:"chartType,omitempty"` // "bar" | "line"
}

// HasData reports whether the spec carries at least one non-empty series.
func (s Spec) HasData() bool {
	for _, d := range s.Datasets {
		if len(d.Values) > 0 {
			return true
		}
	}
	return false
}

// JSON renders the spec for a <script type="application/json"> island.
// HTML escaping is left on so a "</script>" in any label can't close the tag.
func (s Spec) JSON() template.JS {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(true)
	if err := enc.Encode(s); err != nil {
		return template.JS("{}")
	}
	return template.JS(bytes.TrimRight(buf.Bytes(), "\n")) //nolint:gosec // HTML-escaped JSON; see doc comment
}
