// Package assets embeds the panel's static files (HTMX, CSS, small
// JS shims) so the binary ships with everything it needs to render.
package assets

import "embed"

//go:embed *.js *.css css
var FS embed.FS
