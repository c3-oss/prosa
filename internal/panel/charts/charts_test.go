package charts

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

var update = flag.Bool("update", false, "update golden SVG files")

func assertGolden(t *testing.T, name, got string) {
	t.Helper()
	golden := filepath.Join("testdata", name)
	if *update {
		require.NoError(t, os.WriteFile(golden, []byte(got), 0o644))
	}
	want, err := os.ReadFile(golden)
	require.NoError(t, err, "missing golden %s — run: go test ./internal/panel/charts/ -update", golden)
	require.Equal(t, string(want), got, "SVG drifted from golden %s", name)
}

func sampleDonut() string {
	return string(Donut(
		[]Slice{
			{Label: "claude-opus-4-5", Value: 12.5},
			{Label: "claude-sonnet-4-6", Value: 6.25},
			{Label: "gpt-5-codex", Value: 1.25},
		},
		DonutOpts{CenterLabel: "$20.00", CenterSub: "spend", UnitSuffix: ""},
	))
}

func sampleArea() string {
	pts := make([]Point, 24)
	vals := []float64{0, 0, 0, 0, 0, 0, 1, 2, 4, 7, 9, 8, 6, 5, 7, 10, 8, 5, 3, 2, 1, 0, 0, 0}
	for h := 0; h < 24; h++ {
		pts[h] = Point{Label: hourLabel(h), Value: vals[h]}
	}
	return string(Area(pts, AreaOpts{UnitSuffix: " sessions"}))
}

func hourLabel(h int) string {
	if h < 10 {
		return "0" + string(rune('0'+h)) + "h"
	}
	return string(rune('0'+h/10)) + string(rune('0'+h%10)) + "h"
}

func TestDonutGolden(t *testing.T) {
	assertGolden(t, "donut.svg", sampleDonut())
}

func TestAreaGolden(t *testing.T) {
	assertGolden(t, "area.svg", sampleArea())
}

func TestDonutDeterministic(t *testing.T) {
	require.Equal(t, sampleDonut(), sampleDonut())
}

func TestAreaDeterministic(t *testing.T) {
	require.Equal(t, sampleArea(), sampleArea())
}

func TestDonutEscapesLabels(t *testing.T) {
	out := string(Donut([]Slice{{Label: `<script>&"`, Value: 1}}, DonutOpts{}))
	require.NotContains(t, out, "<script>")
	require.Contains(t, out, "&lt;script&gt;")
}

func TestDonutEmptyStillRendersTrack(t *testing.T) {
	out := string(Donut(nil, DonutOpts{CenterLabel: "$0.00"}))
	require.Contains(t, out, "<svg")
	require.Contains(t, out, "var(--bg-elev-2)") // track ring
	require.Contains(t, out, "$0.00")
}

func TestAreaPeakMarkerOnMax(t *testing.T) {
	out := sampleArea()
	require.Contains(t, out, "<circle") // peak marker present
	require.Contains(t, out, "15h: 10 sessions")
}

func TestAreaAllZeroFlatBaseline(t *testing.T) {
	pts := []Point{{Label: "00h"}, {Label: "01h"}, {Label: "02h"}}
	out := string(Area(pts, AreaOpts{}))
	require.Contains(t, out, "<svg")
	require.NotContains(t, out, "<circle") // no peak when there is no data
}

func TestAreaEmpty(t *testing.T) {
	out := string(Area(nil, AreaOpts{}))
	require.True(t, strings.HasPrefix(out, "<svg"))
	require.True(t, strings.HasSuffix(out, "</svg>"))
}

func TestPaletteColorCyclesAndWraps(t *testing.T) {
	require.Equal(t, "var(--accent)", PaletteColor(0))
	require.Equal(t, PaletteColor(0), PaletteColor(5)) // wraps at len
	require.NotEmpty(t, PaletteColor(3))
}
