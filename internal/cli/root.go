// Package cli wires up the prosa CLI: cobra command tree, persistent
// flags, and the dispatcher for sub-commands. Rendering lives in
// internal/cli/render; long-running progress in internal/cli/spinner.
package cli

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/buildinfo"
)

// globalFlags is the persistent flag set inherited by every sub-command.
// Cut 1 only honors --last and --json; the rest are wired so the public
// surface stays stable, but the query layer ignores them with a TODO.
type globalFlags struct {
	Last    string
	Project string
	Device  string
	Agent   string
	All     bool
	JSON    bool
}

var g globalFlags

func newRootCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "prosa",
		Short: "Unified history of AI agent sessions",
		Long: "prosa consolidates Claude Code (and, soon, Codex/others) session histories " +
			"into a single local SQLite store and renders a queryable timeline.",
		RunE:          runNu,
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       buildinfo.String(),
	}
	pf := cmd.PersistentFlags()
	pf.StringVar(&g.Last, "last", "7d", "window length (e.g. 7d, 30d, 12h)")
	pf.StringVar(&g.Project, "project", "", "filter by project path (substring match)")
	pf.StringVar(&g.Device, "device", "", "filter by device friendly name")
	pf.StringVar(&g.Agent, "agent", "", "filter by agent (claude-code | codex)")
	pf.BoolVar(&g.All, "all", false, "disable the cwd-based project auto-filter")
	pf.BoolVar(&g.JSON, "json", false, "emit NDJSON instead of human-formatted output")

	cmd.AddCommand(newSyncCmd())
	cmd.AddCommand(newShowCmd())
	cmd.AddCommand(newSearchCmd())
	cmd.AddCommand(newAnalyticsCmd())
	cmd.AddCommand(newLoginCmd())
	cmd.AddCommand(newLogoutCmd())
	cmd.AddCommand(newDevicesCmd())
	return cmd
}

// Execute is the entry point invoked by cmd/prosa/main.go. It returns the
// process exit code (0 on success, 1 on error).
func Execute() int {
	cmd := newRootCmd()
	if err := cmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	return 0
}
