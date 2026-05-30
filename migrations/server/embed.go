// Package server exposes the embedded Postgres migrations as an fs.FS so
// the internal/server/storage package can apply them at startup without
// depending on the filesystem at runtime — same convention as
// migrations/local.
package server

import "embed"

//go:embed *.sql
var FS embed.FS
