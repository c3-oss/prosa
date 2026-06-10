package charts

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func sampleStacked() string {
	return string(StackedColumns(
		[]string{"05-01", "05-02", "05-03", "05-04", "05-05"},
		[]Series{
			{Name: "claude-code", Values: []float64{4, 0, 7, 2, 5}},
			{Name: "codex", Values: []float64{1, 3, 0, 2, 1}},
		},
		StackedOpts{UnitSuffix: " sessions"},
	))
}

func sampleStackedNormalized() string {
	return string(StackedColumns(
		[]string{"W18", "W19", "W20"},
		[]Series{
			{Name: "claude-opus-4-5", Values: []float64{8, 5, 2}},
			{Name: "gpt-5-codex", Values: []float64{2, 5, 8}},
		},
		StackedOpts{Normalize: true, UnitSuffix: " sessions"},
	))
}

func sampleStackedOverlay() string {
	return string(StackedColumns(
		[]string{"05-01", "05-02", "05-03", "05-04"},
		[]Series{
			{Name: "spend", Values: []float64{1.5, 0.25, 2, 0.75}},
		},
		StackedOpts{UnitSuffix: " USD", Overlay: []float64{1.5, 1.75, 3.75, 4.5}, OverlaySuffix: " USD total"},
	))
}

func TestStackedColumnsGolden(t *testing.T) {
	assertGolden(t, "stacked.svg", sampleStacked())
}

func TestStackedNormalizedGolden(t *testing.T) {
	assertGolden(t, "stacked_normalized.svg", sampleStackedNormalized())
}

func TestStackedOverlayGolden(t *testing.T) {
	assertGolden(t, "stacked_overlay.svg", sampleStackedOverlay())
}

func TestStackedColumnsDeterministic(t *testing.T) {
	require.Equal(t, sampleStacked(), sampleStacked())
	require.Equal(t, sampleStackedOverlay(), sampleStackedOverlay())
}

func TestStackedColumnsEscapesTitles(t *testing.T) {
	out := string(StackedColumns(
		[]string{`<b>"day"</b>`},
		[]Series{{Name: `<script>&`, Values: []float64{1}}},
		StackedOpts{},
	))
	require.NotContains(t, out, "<script>")
	require.Contains(t, out, "&lt;script&gt;")
}

func TestStackedColumnsEmpty(t *testing.T) {
	out := string(StackedColumns(nil, nil, StackedOpts{}))
	require.True(t, strings.HasPrefix(out, "<svg"))
	require.True(t, strings.HasSuffix(out, "</svg>"))
	require.NotContains(t, out, "<rect")
}

func TestStackedColumnsSkipsNonPositive(t *testing.T) {
	out := string(StackedColumns(
		[]string{"a", "b"},
		[]Series{{Name: "x", Values: []float64{0, -2}}},
		StackedOpts{},
	))
	require.NotContains(t, out, "<rect")
}

func TestStackedNormalizedTitlesCarryShare(t *testing.T) {
	out := sampleStackedNormalized()
	require.Contains(t, out, "(80%)") // W18 claude-opus share
	require.Contains(t, out, "(20%)")
}

func TestStackedOverlayEndMarker(t *testing.T) {
	out := sampleStackedOverlay()
	require.Contains(t, out, "<path")
	require.Contains(t, out, "05-04: 4.5 USD total")
}

func TestStackedSegmentsMatchPalette(t *testing.T) {
	out := sampleStacked()
	require.Contains(t, out, PaletteColor(0))
	require.Contains(t, out, PaletteColor(1))
}
