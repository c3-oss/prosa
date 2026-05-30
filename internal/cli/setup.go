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
	"github.com/c3-oss/prosa/internal/importers/claudecode"
	"github.com/c3-oss/prosa/internal/importers/codex"
	"github.com/c3-oss/prosa/internal/importers/cursor"
	"github.com/c3-oss/prosa/internal/importers/gemini"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/pkg/importer"
)

// setupDefaultServer is used when neither --server nor PROSA_SERVER_URL
// is set. Lives here instead of the rpc package because it's a wizard
// default, not a transport default.
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
		Short: "First-run wizard: detect agents, authenticate, schedule, first scan",
		Long: "prosa setup walks a fresh machine from zero to a self-syncing install: " +
			"environment + installed agents + server URL + device auth + LaunchAgent " +
			"(macOS) or systemd timer (Linux) + first scan. Idempotent — re-running " +
			"is safe and reuses cached auth and existing scheduler entries.",
		RunE: runSetup,
	}
	cmd.Flags().StringVar(&setupServerFlag, "server", "",
		"prosa-server URL (default: $PROSA_SERVER_URL or "+setupDefaultServer+")")
	cmd.Flags().DurationVar(&setupIntervalFlag, "interval", 15*time.Minute,
		"scheduler interval (e.g. 15m, 1h)")
	cmd.Flags().BoolVar(&setupSkipScanFlag, "skip-scan", false,
		"skip the first sync at the end of setup")
	cmd.Flags().BoolVar(&setupNonInteractive, "non-interactive", false,
		"no prompts, no ANSI escapes; defaults or env vars must supply every value")
	return cmd
}

// agentReport summarizes one importer's discoverability on this machine.
type agentReport struct {
	name     string
	roots    []string
	foundAny bool
}

// detectAgents iterates the registered importers and asks each whether
// any of its DefaultRoots() exists on the filesystem. Pure read; no side
// effects. Order is stable.
func detectAgents() []agentReport {
	imps := []importer.Importer{
		claudecode.New(),
		codex.New(),
		cursor.New(),
		gemini.New(),
	}
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

	// Steps 1-3: environment, agents, server.
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

	// Step 4: device-code auth (or fast-path on cached token).
	if err := runSetupAuth(ctx, server, interactive); err != nil {
		return err
	}

	// Step 5: scheduler install.
	if err := runSetupScheduler(ctx, interactive); err != nil {
		return err
	}

	// Step 6: first scan (opt-in).
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
		// runSync drives its own progress UI inline; on exit we print
		// the setup footer below sync's summary.
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

// runSetupAuth implements step 4. Fast-path: if auth.json already names
// the same server, skip the device-code dance.
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
	// "→ auth waiting" goes out before StartLogin, so the user sees
	// activity even on slow networks.
	if interactive {
		fmt.Fprintf(os.Stdout, "%s auth         %s\n",
			render.StyleAccent.Render("→"),
			render.StyleMuted.Render("waiting for browser approval"))
	} else {
		fmt.Fprintln(os.Stdout, "step=auth\tstatus=waiting")
	}

	var urlBlockLines int
	onPending := func(url, code string) {
		if interactive {
			fmt.Fprintln(os.Stdout)
			fmt.Fprintln(os.Stdout, render.StyleMuted.Render("Open this URL if the browser did not start:"))
			fmt.Fprintf(os.Stdout, "  %s\n", render.StyleAccent.Render(url))
			fmt.Fprintf(os.Stdout, "  %s\n", styleUserCode.Render(code))
			// blank + hint + url + code
			urlBlockLines = 4
		} else {
			fmt.Fprintf(os.Stdout, "step=auth\tauth_url=%s\tuser_code=%s\n", url, code)
		}
	}
	onApproved := func() {
		if interactive {
			// Jump back over the URL block AND the "→ auth waiting"
			// line, then erase to end of screen and redraw the step
			// as approved. Same redraw trick as runLogin, with the
			// line count computed instead of hardcoded.
			fmt.Fprintf(os.Stdout, "\033[%dF\033[J", urlBlockLines+1)
			fmt.Fprintf(os.Stdout, "%s auth         %s\n",
				render.StyleSuccess.Render("✓"),
				render.StyleSuccess.Render("approved"))
		} else {
			fmt.Fprintln(os.Stdout, "step=auth\tstatus=approved")
		}
	}
	return deviceLogin(ctx, server, onPending, onApproved)
}

// runSetupScheduler implements step 5. Skips silently on platforms with
// no native scheduler instead of failing — the rest of setup is still
// valuable.
func runSetupScheduler(ctx context.Context, interactive bool) error {
	sched, err := schedule.NewForCurrent()
	if err != nil {
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
		return err
	}
	binary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve binary path: %w", err)
	}
	if err := sched.Install(ctx, binary, setupIntervalFlag); err != nil {
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

// renderAgentSummary returns a "·"-separated list of agents, agent style
// for found ones and muted for missing ones. Order is stable so the
// summary reads the same across runs.
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

// schedulerKind returns the OS-native label for the scheduler being
// installed, used by the interactive checklist. Off-platform values
// fall through to the raw GOOS string.
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
