// prosa is the local CLI: import, list, drill-down into agent sessions.
package main

import (
	"os"

	"github.com/c3-oss/prosa/internal/cli"
)

func main() {
	os.Exit(cli.Execute())
}
