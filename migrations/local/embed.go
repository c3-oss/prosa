// Package local exposes the embedded SQLite migrations as an fs.FS so the
// store package can apply them at startup without depending on the
// filesystem at runtime.
package local

import "embed"

//go:embed *.sql
var FS embed.FS
