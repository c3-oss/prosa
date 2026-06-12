// Package cli wires up the prosa CLI: cobra command tree, persistent
// flags, and the dispatcher for sub-commands. Rendering lives in
// internal/cli/render; long-running progress in internal/cli/spinner.
package cli

import (
	"errors"
	"fmt"
	"os"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/buildinfo"
)

// globalFlags is the persistent flag set inherited by every sub-command.
// --remote is persistent so `prosa --remote analytics usage` works; cobra
// rejects a local flag placed before its subcommand.
type globalFlags struct {
	Last    string
	Since   string
	Between string
	Project string
	Device  string
	Agent   string
	Profile string
	All     bool
	JSON    bool
	NoColor bool
	Limit   int
	Remote  bool
}

var g globalFlags

func newRootCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "prosa",
		Short: "Unified history of AI agent sessions",
		RunE:  runNu,
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			if err := validateGlobals(cmd); err != nil {
				return err
			}
			applyGlobalFlags()
			return nil
		},
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       buildinfo.String(),
	}
	pf := cmd.PersistentFlags()
	pf.StringVar(&g.Last, "last", "7d", "rolling window length (e.g. 7d, 30d, 12h)")
	pf.StringVar(&g.Since, "since", "", "lower-bound date in UTC (YYYY-MM-DD)")
	pf.StringVar(&g.Between, "between", "", "closed UTC date range (YYYY-MM-DD..YYYY-MM-DD)")
	pf.StringVar(&g.Project, "project", "", "filter by project path (substring match)")
	pf.StringVar(&g.Device, "device", "", "filter by device name")
	pf.StringVar(&g.Agent, "agent", "", "filter by agent ("+registeredAgentHelp()+")")
	pf.StringVar(&g.Profile, "profile", "", "filter by profile name")
	pf.BoolVar(&g.All, "all", false, "show every project, ignoring the current-project auto-filter")
	pf.BoolVar(&g.JSON, "json", false, "print one JSON object per line instead of formatted output")
	pf.BoolVar(&g.NoColor, "no-color", false, "disable color output")
	// Root-local so other subcommands don't advertise it; search treats it as
	// a fallback when --limit appears before the subcommand.
	cmd.Flags().IntVar(&g.Limit, "limit", 0, "cap timeline sessions returned (0 = no limit)")
	pf.BoolVar(&g.Remote, "remote", false, "query the prosa server instead of the local store")

	cmd.AddCommand(newSyncCmd())
	cmd.AddCommand(newShowCmd())
	cmd.AddCommand(newSearchCmd())
	cmd.AddCommand(newAnalyticsCmd())
	cmd.AddCommand(newLoginCmd())
	cmd.AddCommand(newLogoutCmd())
	cmd.AddCommand(newDevicesCmd())
	cmd.AddCommand(newProfilesCmd())
	cmd.AddCommand(newScheduleCmd())
	cmd.AddCommand(newSetupCmd())
	return cmd
}

// validateGlobals rejects flag combinations that are contradictory (INTENT §5).
func validateGlobals(cmd *cobra.Command) error {
	if cmd.Flags().Changed("all") && cmd.Flags().Changed("project") {
		return errors.New("--all and --project are mutually exclusive")
	}
	if err := validateAgentName(g.Agent); err != nil {
		return err
	}
	return nil
}

func applyGlobalFlags() {
	if g.NoColor {
		lipgloss.SetColorProfile(termenv.Ascii)
	}
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
