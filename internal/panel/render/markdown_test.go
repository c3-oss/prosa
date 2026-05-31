package render

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMarkdownEmpty(t *testing.T) {
	require.Equal(t, "", string(Markdown("")))
}

func TestMarkdownHeading(t *testing.T) {
	got := string(Markdown("# Hello world"))
	require.Contains(t, got, "<h1")
	require.Contains(t, got, "Hello world")
}

func TestMarkdownFencedCodeBlockKeepsLanguageHint(t *testing.T) {
	in := "```go\nfunc main() {}\n```"
	got := string(Markdown(in))
	require.Contains(t, got, `<code class="language-go">`)
	require.Contains(t, got, "func main()")
}

func TestMarkdownList(t *testing.T) {
	in := "- one\n- two\n- three"
	got := string(Markdown(in))
	require.Contains(t, got, "<ul>")
	require.Contains(t, got, "<li>one</li>")
}

func TestMarkdownLink(t *testing.T) {
	got := string(Markdown("[prosa](https://example.com)"))
	require.Contains(t, got, `<a href="https://example.com"`)
	require.Contains(t, got, ">prosa</a>")
}

func TestMarkdownBoldItalic(t *testing.T) {
	got := string(Markdown("This is **bold** and *italic*."))
	require.Contains(t, got, "<strong>bold</strong>")
	require.Contains(t, got, "<em>italic</em>")
}

func TestMarkdownBlockquote(t *testing.T) {
	got := string(Markdown("> a quote"))
	require.Contains(t, got, "<blockquote>")
}

func TestMarkdownRawHTMLOmitted(t *testing.T) {
	// A literal <script> in assistant output must NOT execute as HTML.
	// Goldmark with WithUnsafe disabled either escapes or omits raw
	// blocks; either is safe. The hard requirement is "no live script
	// tag in the output".
	in := "before <script>alert(1)</script> after"
	got := string(Markdown(in))
	require.NotContains(t, got, "<script>")
	require.NotContains(t, got, "</script>")
}

func TestMarkdownGFMTable(t *testing.T) {
	in := "| a | b |\n| - | - |\n| 1 | 2 |"
	got := string(Markdown(in))
	require.Contains(t, got, "<table>")
	require.Contains(t, got, "<th>a</th>")
	require.Contains(t, got, "<td>1</td>")
}

func TestMarkdownGFMAutolink(t *testing.T) {
	in := "see https://example.com for context"
	got := string(Markdown(in))
	require.Contains(t, got, `href="https://example.com"`)
}

func TestMarkdownHardWraps(t *testing.T) {
	// HardWraps turns chat-style newlines into <br>, matching how
	// model output reads in the bubble.
	in := "line one\nline two"
	got := string(Markdown(in))
	require.True(t, strings.Contains(got, "<br>"),
		"expected <br> from HardWraps in %q", got)
}

func TestPlainTextEscapes(t *testing.T) {
	in := `<b>not bold</b> & "quoted"`
	got := string(PlainText(in))
	require.NotContains(t, got, "<b>")
	require.Contains(t, got, "&lt;b&gt;")
	require.Contains(t, got, "&amp;")
	require.Contains(t, got, "&#34;")
}

func TestPlainTextNewlinesBecomeBr(t *testing.T) {
	got := string(PlainText("a\nb\nc"))
	require.Equal(t, "a<br>\nb<br>\nc", got)
}

func TestPlainTextEmpty(t *testing.T) {
	require.Equal(t, "", string(PlainText("")))
}
