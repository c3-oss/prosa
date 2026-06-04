package panel

import (
	"bytes"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

func TestIsBinaryChunkDetectsSQLiteMagic(t *testing.T) {
	// SQLite databases (Cursor's store.db) begin with this 16-byte
	// magic. The Cursor importer preserves the file verbatim, so the
	// panel sees the magic at offset 0.
	in := []byte("SQLite format 3\x00")
	in = append(in, bytes.Repeat([]byte{0x00}, 64)...)
	require.True(t, isBinaryChunk(in))
}

func TestIsBinaryChunkDetectsNULByteAnywhereInSniffWindow(t *testing.T) {
	in := append([]byte("perfectly readable header until -> "), 0x00)
	in = append(in, []byte("then more text")...)
	require.True(t, isBinaryChunk(in))
}

func TestIsBinaryChunkDetectsInvalidUTF8(t *testing.T) {
	// 0xC3 0x28 is an incomplete 2-byte UTF-8 sequence — invalid.
	in := []byte{0xC3, 0x28, 'h', 'i'}
	require.True(t, isBinaryChunk(in))
}

func TestIsBinaryChunkAcceptsASCII(t *testing.T) {
	in := []byte(`{"type":"user","content":"refactor sync"}`)
	require.False(t, isBinaryChunk(in))
}

func TestIsBinaryChunkAcceptsMultibyteUTF8(t *testing.T) {
	in := []byte("refatorar a lógica de sincronização — agora 🚀")
	require.False(t, isBinaryChunk(in))
}

func TestIsBinaryChunkAcceptsUTF8RuneCrossingSniffBoundary(t *testing.T) {
	in := bytes.Repeat([]byte("a"), 4095)
	in = append(in, []byte("é stays text")...)
	require.False(t, isBinaryChunk(in))
}

func TestIsBinaryChunkAcceptsEmpty(t *testing.T) {
	require.False(t, isBinaryChunk(nil))
	require.False(t, isBinaryChunk([]byte{}))
}

func TestIsBinaryChunkOnlyLooksAtFirstSniffN(t *testing.T) {
	// A NUL beyond the 4096-byte sniff window must NOT trip the
	// detector (otherwise text-y chunks pulled across NUL-bearing
	// payloads later in the file would be falsely flagged).
	in := bytes.Repeat([]byte("a"), 4096)
	in = append(in, 0x00)
	require.False(t, isBinaryChunk(in))
}

func TestBinaryPlaceholderMentionsSize(t *testing.T) {
	out := binaryPlaceholder(123456)
	require.Contains(t, out, "123456")
	require.True(t, strings.Contains(out, "Binary"),
		"placeholder should label the content as binary")
}

// TestLoadViewsParsesAllTemplates catches template parse errors at
// build time instead of at the first GET that lands on a broken view.
// Failing here means a {{...}} block is unbalanced, a referenced
// template name is missing, or a field accessor uses bad syntax.
func TestLoadViewsParsesAllTemplates(t *testing.T) {
	views, err := loadViews()
	require.NoError(t, err)
	for _, name := range []string{"home", "sessions", "projects", "settings", "devices", "login", "cli_authorize", "side_panel", "raw_chunk"} {
		require.Contains(t, views, name, "view %q should be parsed", name)
	}
}

func TestBuildDisplayTurnsSanitizesAndDoesNotMutateInput(t *testing.T) {
	original := []*prosav1.Turn{
		{Role: "user", Content: "hello \x1b[1mworld\x1b[22m"},
		{Role: "assistant", Content: "ok\x00 trailing"},
		nil, // nil turn skipped
	}
	got := buildDisplayTurns(original)
	require.Len(t, got, 2, "nil turn is dropped, not preserved as zero value")
	require.Equal(t, "user", got[0].Role)
	require.Equal(t, "assistant", got[1].Role)
	require.Contains(t, string(got[0].Body), "hello world")
	require.Contains(t, string(got[1].Body), "ok trailing")

	// Defensive copy: the original protos are untouched so concurrent
	// requests sharing the connect response don't race on Content.
	require.Equal(t, "hello \x1b[1mworld\x1b[22m", original[0].Content)
	require.Equal(t, "ok\x00 trailing", original[1].Content)
}

func TestBuildDisplayTurnsAssistantUsesMarkdown(t *testing.T) {
	in := []*prosav1.Turn{
		{Role: "assistant", Content: "**bold** and `code`"},
	}
	got := buildDisplayTurns(in)
	require.Len(t, got, 1)
	body := string(got[0].Body)
	require.Contains(t, body, "<strong>bold</strong>")
	require.Contains(t, body, "<code>code</code>")
}

func TestBuildDisplayTurnsUserStaysEscapedPlain(t *testing.T) {
	in := []*prosav1.Turn{
		{Role: "user", Content: "**not bold**\n<script>x</script>"},
	}
	got := buildDisplayTurns(in)
	require.Len(t, got, 1)
	body := string(got[0].Body)
	require.NotContains(t, body, "<strong>")
	require.NotContains(t, body, "<script>")
	require.Contains(t, body, "**not bold**")
	require.Contains(t, body, "<br>")
}

func TestBuildDisplayTurnsEmpty(t *testing.T) {
	require.Empty(t, buildDisplayTurns(nil))
	require.Empty(t, buildDisplayTurns([]*prosav1.Turn{}))
}

func TestHumanDuration(t *testing.T) {
	cases := []struct {
		in   time.Duration
		want string
	}{
		{0, "—"},
		{-1 * time.Second, "—"},
		{30 * time.Second, "30s"},
		{59 * time.Second, "59s"},
		{2 * time.Minute, "2m"},
		{2*time.Minute + 14*time.Second, "2m 14s"},
		{5 * time.Minute, "5m"},
		{18 * time.Minute, "18m"},
		{1 * time.Hour, "1h"},
		{1*time.Hour + 30*time.Minute, "1h 30m"},
		{23*time.Hour + 59*time.Minute, "23h 59m"},
		{24 * time.Hour, "1d"},
		{4*24*time.Hour + 6*time.Hour, "4d 6h"},
	}
	for _, c := range cases {
		require.Equal(t, c.want, humanDuration(c.in), "humanDuration(%s)", c.in)
	}
}

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

func TestFormatTokensCompact(t *testing.T) {
	tests := []struct {
		n    int64
		want string
	}{
		{0, "0"},
		{850, "850"},
		{999, "999"},
		{1000, "1k"},
		{1200, "1.2k"},
		{2000, "2k"},
		{999_499, "999.5k"},
		{999_990, "1m"},
		{1_000_000, "1m"},
		{1_234_567, "1.2m"},
		{2_363_628_148, "2.4b"},
		{-1500, "-1.5k"},
	}
	for _, tc := range tests {
		t.Run(strconv.FormatInt(tc.n, 10), func(t *testing.T) {
			require.Equal(t, tc.want, formatTokensCompact(tc.n))
		})
	}
}
