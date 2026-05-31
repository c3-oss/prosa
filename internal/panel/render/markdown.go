// Package render turns canonical session content into the HTML the
// sidepanel template ships. Assistant bodies are markdown on the
// wire — goldmark renders them safely; user and tool bodies stay
// escaped plain text with newlines preserved.
package render

import (
	"bytes"
	"html"
	"html/template"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	gmhtml "github.com/yuin/goldmark/renderer/html"
)

// md is the package-wide markdown renderer. Configured once, used by
// every Render call. Hardwraps so chat-style "\n" turns into <br>.
// Unsafe HTML is intentionally disabled — goldmark HTML-escapes any
// inline markup the model emits.
var md = goldmark.New(
	goldmark.WithExtensions(extension.GFM),
	goldmark.WithParserOptions(parser.WithAutoHeadingID()),
	goldmark.WithRendererOptions(gmhtml.WithHardWraps()),
)

// Markdown renders s as a Markdown document and returns the HTML
// fragment. On any renderer error the input is escaped and returned
// verbatim so the panel still shows something legible.
func Markdown(s string) template.HTML {
	if s == "" {
		return ""
	}
	var buf bytes.Buffer
	if err := md.Convert([]byte(s), &buf); err != nil {
		return template.HTML(escapePreserveLines(s))
	}
	return template.HTML(buf.String())
}

// PlainText returns s HTML-escaped with newlines preserved as <br>
// so user prompts (which aren't markdown) keep their line breaks
// without enabling the rest of the markdown surface.
func PlainText(s string) template.HTML {
	if s == "" {
		return ""
	}
	return template.HTML(escapePreserveLines(s))
}

func escapePreserveLines(s string) string {
	return strings.ReplaceAll(html.EscapeString(s), "\n", "<br>\n")
}
