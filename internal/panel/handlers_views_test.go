package panel

import (
	"net/url"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

// usageRow shapes the eight-column AnalyticsRow the server emits for the
// "usage" report. Integers go in raw (no thousands separators) because
// the panel parses them with strconv.ParseInt.
func usageRow(agent string, sessions, measured, total, input, output, cached int64, cost string) *prosav1.AnalyticsRow {
	return &prosav1.AnalyticsRow{Values: []string{
		agent,
		strconv.FormatInt(sessions, 10),
		strconv.FormatInt(measured, 10),
		strconv.FormatInt(total, 10),
		strconv.FormatInt(input, 10),
		strconv.FormatInt(output, 10),
		strconv.FormatInt(cached, 10),
		cost,
	}}
}

func TestBuildUsage_HidesZeroTokenAgents(t *testing.T) {
	rows := []*prosav1.AnalyticsRow{
		usageRow("cursor", 654, 0, 0, 0, 0, 0, ""),
		usageRow("codex", 1761, 1531, 8869844323, 8828845273, 40877450, 8377491617, "4697.1771"),
	}
	out, totalTokens, totalCost := buildUsage(rows)
	require.Len(t, out, 1, "cursor (zero total) should be filtered out")
	require.Equal(t, "codex", out[0].Agent)
	require.Equal(t, int64(8869844323), totalTokens)
	require.Equal(t, "$4697.18", totalCost, "totalCost rounded to 2 decimals")
	require.Equal(t, "$4697.18", out[0].Cost, "per-row cost rounded to 2 decimals")
}

func TestBuildUsage_NoPriced_ReturnsNA(t *testing.T) {
	rows := []*prosav1.AnalyticsRow{
		usageRow("codex", 10, 5, 1000, 800, 200, 0, ""),
	}
	out, totalTokens, totalCost := buildUsage(rows)
	require.Len(t, out, 1)
	require.Equal(t, int64(1000), totalTokens)
	require.Equal(t, "n/a", totalCost)
	require.Equal(t, "n/a", out[0].Cost)
}

func TestBuildUsage_AllZero_ReturnsEmpty(t *testing.T) {
	rows := []*prosav1.AnalyticsRow{
		usageRow("cursor", 654, 0, 0, 0, 0, 0, ""),
	}
	out, totalTokens, totalCost := buildUsage(rows)
	require.Empty(t, out)
	require.Equal(t, int64(0), totalTokens)
	require.Equal(t, "n/a", totalCost)
}

func TestBuildHeatmap_PerAgentBreakdown(t *testing.T) {
	// Two adjacent days: one with three agents, one empty.
	rows := []*prosav1.AnalyticsRow{
		{Values: []string{"2026-05-22", "claude-code", "4"}},
		{Values: []string{"2026-05-22", "codex", "5"}},
		{Values: []string{"2026-05-22", "gemini", "3"}},
		{Values: []string{"2026-05-23", "", "0"}}, // empty day from server
	}
	view := buildHeatmap(rows)
	require.Equal(t, int64(12), view.Total)
	require.Equal(t, int64(12), view.Max)

	// Cells include leading blanks (weekday alignment) + the two day cells.
	var found2022, found2023 *heatmapCell
	for i := range view.Cells {
		c := &view.Cells[i]
		switch c.Date {
		case "2026-05-22":
			found2022 = c
		case "2026-05-23":
			found2023 = c
		}
	}
	require.NotNil(t, found2022)
	require.Equal(t, int64(12), found2022.Count)
	require.Len(t, found2022.Agents, 3)
	require.Equal(t, "codex", found2022.Agents[0].Name)
	require.Equal(t, int64(5), found2022.Agents[0].Count)
	require.Equal(t, "claude-code", found2022.Agents[1].Name)
	require.Equal(t, "gemini", found2022.Agents[2].Name)

	require.NotNil(t, found2023)
	require.Equal(t, int64(0), found2023.Count)
	require.Empty(t, found2023.Agents)
}

func TestPickDeviceNames(t *testing.T) {
	q, _ := url.ParseQuery("device=alpha&device=&device=beta&device=%20%20")
	got := pickDeviceNames(q)
	require.Equal(t, []string{"alpha", "beta"}, got)

	emptyQ, _ := url.ParseQuery("agent=codex")
	require.Empty(t, pickDeviceNames(emptyQ))
}

func TestSummarizeDevicePick(t *testing.T) {
	require.Equal(t, "all devices", summarizeDevicePick(nil, 5))
	require.Equal(t, "studio-m4", summarizeDevicePick([]string{"studio-m4"}, 5))
	require.Equal(t, "3 devices", summarizeDevicePick([]string{"a", "b", "c"}, 5))
}
