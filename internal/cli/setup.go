package cli

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/cli/rpc"
	"github.com/c3-oss/prosa/internal/cli/schedule"
	"github.com/c3-oss/prosa/internal/paths"
)

// setupDefaultServer is the wizard default, not a transport default.
const setupDefaultServer = "https://prosa.c3.do"

var (
	setupServerFlag     string
	setupIntervalFlag   time.Duration
	setupSkipScanFlag   bool
	setupNonInteractive bool
)

func newSetupCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "setup",
		Short: "Set up a fresh machine: detect agents, log in, schedule, first sync",
		Long: "Detects installed agents, authenticates this device, installs the background " +
			"sync job, and runs the first sync. Safe to re-run.",
		RunE: runSetup,
	}
	cmd.Flags().StringVar(&setupServerFlag, "server", "",
		"prosa server URL (default: $PROSA_SERVER_URL or "+setupDefaultServer+")")
	cmd.Flags().DurationVar(&setupIntervalFlag, "interval", 15*time.Minute,
		"background sync interval (e.g. 15m, 1h)")
	cmd.Flags().BoolVar(&setupSkipScanFlag, "skip-scan", false,
		"skip the first sync at the end")
	cmd.Flags().BoolVar(&setupNonInteractive, "non-interactive", false,
		"no prompts and no formatting; values must come from flags or env")
	return cmd
}

// agentReport summarizes one importer's discoverability on this machine.
type agentReport struct {
	name     string
	roots    []string
	foundAny bool
}

func detectAgents() []agentReport {
	imps := registeredImporters()
	out := make([]agentReport, 0, len(imps))
	for _, imp := range imps {
		roots := imp.DefaultRoots()
		report := agentReport{name: imp.Name(), roots: roots}
		for _, r := range roots {
			if _, err := os.Stat(r); err == nil {
				report.foundAny = true
				break
			}
		}
		out = append(out, report)
	}
	return out
}

func runSetup(cmd *cobra.Command, _ []string) error {
	ctx := rpc.ContextOrBackground(cmd.Context())
	interactive := !setupNonInteractive && IsInteractive()

	cwd, _ := os.Getwd()
	storePath, err := paths.StorePath()
	if err != nil {
		return err
	}

	server := setupServerFlag
	if server == "" {
		server = os.Getenv("PROSA_SERVER_URL")
	}
	if server == "" {
		server = setupDefaultServer
	}
	if u, err := url.Parse(server); err != nil || u.Scheme == "" {
		return fmt.Errorf("invalid server URL: %q", server)
	}

	reports := detectAgents()
	var foundAgents []string
	for _, a := range reports {
		if a.foundAny {
			foundAgents = append(foundAgents, a.name)
		}
	}

	if interactive {
		fmt.Fprintln(os.Stdout, render.StyleHeader.Render("prosa setup"))
		fmt.Fprintf(os.Stdout, "%s    %s\n",
			render.StyleMuted.Render("cwd"),
			render.StyleAccent.Render(cwd))
		fmt.Fprintf(os.Stdout, "%s  %s\n",
			render.StyleMuted.Render("store"),
			render.StyleAccent.Render(storePath))
		fmt.Fprintln(os.Stdout)
		fmt.Fprintf(os.Stdout, "%s agents       %s\n",
			render.StyleSuccess.Render("✓"),
			renderAgentSummary(reports))
		fmt.Fprintf(os.Stdout, "%s server       %s\n",
			render.StyleSuccess.Render("✓"),
			render.StyleAccent.Render(server))
	} else {
		fmt.Fprintf(os.Stdout, "step=cwd\tvalue=%s\n", cwd)
		fmt.Fprintf(os.Stdout, "step=store\tvalue=%s\n", storePath)
		fmt.Fprintf(os.Stdout, "step=agents\tvalue=%s\n",
			strings.Join(foundAgents, ","))
		fmt.Fprintf(os.Stdout, "step=server\tvalue=%s\n", server)
	}

	if err := runSetupAuth(ctx, server, interactive); err != nil {
		return err
	}

	if err := runSetupScheduler(ctx, interactive); err != nil {
		return err
	}

	if setupSkipScanFlag {
		if interactive {
			fmt.Fprintf(os.Stdout, "%s first scan   %s\n",
				render.StyleMuted.Render("·"),
				render.StyleMuted.Render("skipped"))
		} else {
			fmt.Fprintln(os.Stdout, "step=first_scan\tstatus=skipped")
		}
	} else {
		if interactive {
			fmt.Fprintf(os.Stdout, "%s first scan\n",
				render.StyleAccent.Render("→"))
			fmt.Fprintln(os.Stdout)
		} else {
			fmt.Fprintln(os.Stdout, "step=first_scan\tstatus=running")
		}
		if err := runSync(cmd, nil); err != nil {
			return err
		}
	}

	if interactive {
		fmt.Fprintln(os.Stdout)
		fmt.Fprintf(os.Stdout, "%s · next sync in %s\n",
			render.StyleSuccess.Render("ready"),
			setupIntervalFlag.String())
	} else {
		fmt.Fprintln(os.Stdout, "status\tready")
	}
	return nil
}

// runSetupAuth fast-paths when auth.json already names the same server.
func runSetupAuth(ctx context.Context, server string, interactive bool) error {
	if existing, err := rpc.LoadAuth(); err == nil {
		if rpc.NormalizeServerURL(existing.Server) == rpc.NormalizeServerURL(server) {
			if interactive {
				fmt.Fprintf(os.Stdout, "%s auth         %s\n",
					render.StyleSuccess.Render("✓"),
					render.StyleMuted.Render("already approved"))
			} else {
				fmt.Fprintln(os.Stdout, "step=auth\tstatus=cached")
			}
			return nil
		}
	}
	if interactive {
		fmt.Fprintf(os.Stdout, "%s auth         %s\n",
			render.StyleAccent.Render("→"),
			render.StyleMuted.Render("waiting for browser approval"))
	} else {
		fmt.Fprintln(os.Stdout, "step=auth\tstatus=waiting")
	}

	var urlBlockLines int
	onPending := func(url string) {
		if interactive {
			fmt.Fprintln(os.Stdout)
			fmt.Fprintln(os.Stdout, render.StyleMuted.Render("Open this URL if the browser did not start:"))
			fmt.Fprintf(os.Stdout, "  %s\n", render.StyleAccent.Render(url))
			// blank + hint + url
			urlBlockLines = 3
		} else {
			fmt.Fprintf(os.Stdout, "step=auth\tauth_url=%s\n", url)
		}
	}
	onApproved := func() {
		if interactive {
			// Jump back over the URL block and the "→ auth waiting" line; same
			// redraw trick as runLogin but with the line count computed dynamically.
			fmt.Fprintf(os.Stdout, "\033[%dF\033[J", urlBlockLines+1)
			fmt.Fprintf(os.Stdout, "%s auth         %s\n",
				render.StyleSuccess.Render("✓"),
				render.StyleSuccess.Render("approved"))
		} else {
			fmt.Fprintln(os.Stdout, "step=auth\tstatus=approved")
		}
	}
	return pkceLogin(ctx, server, onPending, onApproved)
}

// runSetupScheduler skips silently on platforms with no native scheduler.
func runSetupScheduler(ctx context.Context, interactive bool) error {
	binary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve binary path: %w", err)
	}
	if err := schedule.Install(ctx, binary, setupIntervalFlag); err != nil {
		if errors.Is(err, schedule.ErrUnsupported) {
			if interactive {
				fmt.Fprintf(os.Stdout, "%s scheduler    %s\n",
					render.StyleWarning.Render("·"),
					render.StyleMuted.Render("not supported on this platform"))
			} else {
				fmt.Fprintln(os.Stdout, "step=scheduler\tstatus=skipped\treason=unsupported_platform")
			}
			return nil
		}
		return fmt.Errorf("scheduler install: %w", err)
	}
	if interactive {
		fmt.Fprintf(os.Stdout, "%s scheduler    %s · every %s\n",
			render.StyleSuccess.Render("✓"),
			render.StyleAccent.Render(schedulerKind()),
			render.StyleAccent.Render(setupIntervalFlag.String()))
	} else {
		fmt.Fprintf(os.Stdout, "step=scheduler\tstatus=installed\tkind=%s\tinterval=%s\n",
			schedulerKind(), setupIntervalFlag)
	}
	return nil
}

// renderAgentSummary returns a "·"-separated agent list with found/missing styling.
func renderAgentSummary(reports []agentReport) string {
	if len(reports) == 0 {
		return render.StyleMuted.Render("none detected")
	}
	parts := make([]string, 0, len(reports))
	for _, a := range reports {
		if a.foundAny {
			parts = append(parts, render.StyleAgent.Render(a.name))
		} else {
			parts = append(parts, render.StyleMuted.Render(a.name))
		}
	}
	return strings.Join(parts, render.StyleMuted.Render(" · "))
}

// schedulerKind returns the OS-native scheduler label for the interactive checklist.
func schedulerKind() string {
	switch runtime.GOOS {
	case "darwin":
		return "LaunchAgent"
	case "linux":
		return "systemd timer"
	default:
		return runtime.GOOS
	}
}
