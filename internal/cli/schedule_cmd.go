package cli

import (
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/cli/rpc"
	"github.com/c3-oss/prosa/internal/cli/schedule"
)

var scheduleIntervalFlag time.Duration

func newScheduleCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "schedule",
		Short: "Manage the background prosa-sync job (launchd or systemd timer)",
		Long: "Installs a per-user scheduled job that runs `prosa sync` at a " +
			"fixed interval. macOS uses launchd (~/Library/LaunchAgents). " +
			"Linux uses systemd --user (~/.config/systemd/user).",
	}
	cmd.AddCommand(newScheduleInstallCmd())
	cmd.AddCommand(newScheduleUninstallCmd())
	cmd.AddCommand(newScheduleStatusCmd())
	return cmd
}

func newScheduleInstallCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "install",
		Short: "Install the prosa-sync scheduled job",
		RunE:  runScheduleInstall,
	}
	c.Flags().DurationVar(&scheduleIntervalFlag, "interval", 15*time.Minute,
		"how often the scheduler should run prosa sync (e.g. 15m, 1h)")
	return c
}

func newScheduleUninstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall",
		Short: "Remove the prosa-sync scheduled job",
		RunE:  runScheduleUninstall,
	}
}

func newScheduleStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show whether the prosa-sync scheduled job is installed",
		RunE:  runScheduleStatus,
	}
}

func runScheduleInstall(cmd *cobra.Command, _ []string) error {
	ctx := rpc.ContextOrBackground(cmd.Context())
	binary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve binary path: %w", err)
	}
	if err := schedule.Install(ctx, binary, scheduleIntervalFlag); err != nil {
		return err
	}
	if IsInteractive() {
		fmt.Fprintf(os.Stdout, "%s scheduler installed (interval %s)\n",
			render.StyleSuccess.Render("✓"), scheduleIntervalFlag)
	} else {
		fmt.Fprintf(os.Stdout, "status\tinstalled\ninterval\t%s\n", scheduleIntervalFlag)
	}
	return nil
}

func runScheduleUninstall(cmd *cobra.Command, _ []string) error {
	ctx := rpc.ContextOrBackground(cmd.Context())
	if err := schedule.Uninstall(ctx); err != nil {
		return err
	}
	if IsInteractive() {
		fmt.Fprintf(os.Stdout, "%s scheduler removed\n", render.StyleSuccess.Render("✓"))
	} else {
		fmt.Fprintln(os.Stdout, "status\tuninstalled")
	}
	return nil
}

func runScheduleStatus(cmd *cobra.Command, _ []string) error {
	ctx := rpc.ContextOrBackground(cmd.Context())
	st, err := schedule.Status(ctx)
	if err != nil {
		return err
	}
	if IsInteractive() {
		if st.Installed {
			fmt.Fprintf(os.Stdout, "%s installed     %s\n",
				render.StyleSuccess.Render("✓"),
				render.StyleMuted.Render(st.UnitPath))
			if st.Interval > 0 {
				fmt.Fprintf(os.Stdout, "%s interval      %s\n",
					render.StyleSuccess.Render("✓"),
					render.StyleAccent.Render(st.Interval.String()))
			}
		} else {
			fmt.Fprintf(os.Stdout, "%s not installed\n",
				render.StyleMuted.Render("·"))
			fmt.Fprintln(os.Stdout)
			fmt.Fprintln(os.Stdout, render.StyleMuted.Render("run `prosa schedule install` to enable"))
		}
		return nil
	}
	if st.Installed {
		fmt.Fprintf(os.Stdout, "status\tinstalled\nunit\t%s\ninterval\t%s\n",
			st.UnitPath, st.Interval)
	} else {
		fmt.Fprintln(os.Stdout, "status\tnot_installed")
	}
	return nil
}
