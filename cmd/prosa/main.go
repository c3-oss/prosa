// prosa is the local CLI: import, list, drill-down into agent sessions.
// All real logic lives in internal/cli — this file is just the entry point.
package main

import (
	"os"

	"github.com/c3-oss/prosa/internal/cli"
)

func main() {
	os.Exit(cli.Execute())
}
