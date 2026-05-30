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
//
// --remote is persistent (rather than local to analytics/search) so that
// both `prosa --remote analytics usage` and `prosa analytics --remote
// usage` succeed; cobra rejects a local flag placed before its
// subcommand. Sub-commands that do not honor it ignore the value.
type globalFlags struct {
	Last    string
	Since   string
	Between string
	Project string
	Device  string
	Agent   string
	All     bool
	JSON    bool
	Remote  bool
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
	pf.StringVar(&g.Last, "last", "7d", "rolling window length (e.g. 7d, 30d, 12h); mut.-excl. with --since / --between")
	pf.StringVar(&g.Since, "since", "", "anchored lower bound, YYYY-MM-DD UTC; mut.-excl. with --last / --between")
	pf.StringVar(&g.Between, "between", "", "closed UTC range, YYYY-MM-DD..YYYY-MM-DD; mut.-excl. with --last / --since")
	pf.StringVar(&g.Project, "project", "", "filter by project path (substring match)")
	pf.StringVar(&g.Device, "device", "", "filter by device friendly name")
	pf.StringVar(&g.Agent, "agent", "", "filter by agent (claude-code | codex)")
	pf.BoolVar(&g.All, "all", false, "disable the cwd-based project auto-filter")
	pf.BoolVar(&g.JSON, "json", false, "emit NDJSON instead of human-formatted output")
	pf.BoolVar(&g.Remote, "remote", false, "run the command against prosa-server (analytics, search; ignored elsewhere)")

	cmd.AddCommand(newSyncCmd())
	cmd.AddCommand(newShowCmd())
	cmd.AddCommand(newSearchCmd())
	cmd.AddCommand(newAnalyticsCmd())
	cmd.AddCommand(newLoginCmd())
	cmd.AddCommand(newLogoutCmd())
	cmd.AddCommand(newDevicesCmd())
	cmd.AddCommand(newScheduleCmd())
	cmd.AddCommand(newSetupCmd())
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
