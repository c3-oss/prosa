// prosa-server stub for cut 1. Compiles and runs so the build matrix
// stays honest about the three-binary contract, but it does no work yet.
// Real handlers land once the sync protocol and Postgres+S3 backend are
// implemented in a later cut.
package main

import (
	"fmt"

	"github.com/c3-oss/prosa/internal/buildinfo"
)

func main() {
	fmt.Printf("prosa-server %s: not implemented in first cut\n", buildinfo.String())
}
