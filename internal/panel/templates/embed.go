// Package templates holds the html/template sources rendered by the
// panel handlers. We use html/template (stdlib) rather than templ so
// no codegen step is needed.
package templates

import "embed"

//go:embed *.html
var FS embed.FS
