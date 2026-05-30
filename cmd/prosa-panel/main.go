// prosa-panel stub for cut 1. Compiles and runs so the build matrix
// stays honest about the three-binary contract, but it does no work yet.
// Real handlers (templ + HTMX SSR over the server API) land in a later cut.
package main

import (
	"fmt"

	"github.com/c3-oss/prosa/internal/buildinfo"
)

func main() {
	fmt.Printf("prosa-panel %s: not implemented in first cut\n", buildinfo.String())
}
