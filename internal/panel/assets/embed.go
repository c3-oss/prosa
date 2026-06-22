// Package assets embeds the panel's static files.
package assets

import "embed"

//go:embed *.js *.css css fonts
var FS embed.FS
