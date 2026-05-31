package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/cli/rpc"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/store"
)

var (
	validAnalyticsReports = []string{"sessions", "tools", "models", "projects", "errors", "heatmap", "usage"}
	analyticsRemoteFlag   bool
)

func newAnalyticsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "analytics <report>",
		Short: "Run a fixed SQL report over the local store",
		Long: "Runs one of the built-in reports against the local store. Available:\n" +
			"  sessions  — sessions and turn totals by agent\n" +
			"  tools     — most-used tools across all sessions (top 20)\n" +
			"  models    — sessions per model name\n" +
			"  projects  — sessions per project, agent-grouped (top 30)\n" +
			"  heatmap   — sessions per UTC day for a GitHub-style graph\n" +
			"  usage     — token totals and estimated USD cost by agent\n" +
			"  errors    — sessions whose assistant turns match common error\n" +
			"              signals via FTS5: 'error OR exception OR traceback OR panic OR fatal'\n" +
			"              (heuristic; matches the words in any context).\n\n" +
			"All reports honor the global filter flags (--last / --project / --agent /\n" +
			"--device) and emit NDJSON with --json.\n\n" +
			"--remote re-runs the report on the prosa-server.",
		ValidArgs: validAnalyticsReports,
		Args:      cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs),
		RunE:      runAnalytics,
	}
	cmd.Flags().BoolVar(&analyticsRemoteFlag, "remote", false,
		"run the report against the prosa-server's Postgres")
	return cmd
}

func runAnalytics(cmd *cobra.Command, args []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	report := args[0]

	now := time.Now().UTC()
	w, err := ResolveWindow(cmd, g.Last, g.Since, g.Between, now)
	if err != nil {
		return err
	}

	if analyticsRemoteFlag {
		return runAnalyticsRemote(ctx, report, w)
	}

	storePath, err := paths.StorePath()
	if err != nil {
		return err
	}
	s, err := store.OpenReadOnly(ctx, storePath)
	if err != nil {
		return err
	}
	defer func() { _ = s.Close() }()

	filter := store.SessionFilter{
		Since: w.Since,
		Until: w.Until,
	}
	// Analytics inherits the same filter precedence as nu / search:
	// --project wins; otherwise cwd auto-detect unless --all.
	scope, scopeLabel := applyAnalyticsScope(ctx, s, &filter)
	if g.Agent != "" {
		a := g.Agent
		filter.Agent = &a
	}
	if g.Device != "" {
		d := g.Device
		filter.DeviceName = &d
	}
	if IsInteractive() && !g.JSON {
		fmt.Fprintln(os.Stderr, render.ContextLine(render.ContextLineOptions{
			Command:    "analytics",
			Source:     "local",
			Scope:      scope,
			ScopeLabel: scopeLabel,
			Last:       w.LastLabel,
			Since:      w.SinceLabel,
			Between:    w.BetweenLabel,
		}))
	}

	result, err := dispatchAnalytics(ctx, s, report, filter)
	if err != nil {
		return err
	}

	if g.JSON {
		return emitAnalyticsJSON(os.Stdout, result)
	}
	return render.Analytics(os.Stdout, result, IsInteractive())
}

func applyAnalyticsScope(ctx context.Context, s *store.Store, filter *store.SessionFilter) (render.ContextScope, string) {
	switch {
	case g.Project != "":
		p := g.Project
		filter.ProjectMatch = &p
		return render.ScopeScoped, p
	case g.All:
		return render.ScopeAll, ""
	default:
		if cwd, err := os.Getwd(); err == nil {
			if m, err := DetectProject(ctx, cwd, s); err == nil && m.Found {
				applyMatchFilter(filter, m)
				return render.ScopeScoped, m.HintLabel()
			}
		}
		return render.ScopeProjectNotDetected, ""
	}
}

func dispatchAnalytics(ctx context.Context, s *store.Store, report string, f store.SessionFilter) (store.AnalyticsResult, error) {
	switch report {
	case "sessions":
		return s.AnalyticsSessions(ctx, f)
	case "tools":
		return s.AnalyticsTools(ctx, f)
	case "models":
		return s.AnalyticsModels(ctx, f)
	case "projects":
		return s.AnalyticsProjects(ctx, f)
	case "errors":
		return s.AnalyticsErrors(ctx, f)
	case "heatmap":
		return s.AnalyticsHeatmap(ctx, f)
	case "usage":
		return s.AnalyticsUsage(ctx, f)
	default:
		return store.AnalyticsResult{}, fmt.Errorf("unknown report: %s", report)
	}
}

// runAnalyticsRemote handles --remote through AnalyticsService so CLI and
// panel see the same server-side reports.
func runAnalyticsRemote(ctx context.Context, report string, w Window) error {
	auth, err := rpc.LoadAuth()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("not logged in — run `prosa login --server <URL>` first")
		}
		return err
	}
	req := &prosav1.GetReportRequest{
		Report: report,
		Since:  timestamppb.New(w.Since),
		Until:  timestamppb.New(w.Until),
	}
	scope, scopeLabel := applyAnalyticsRemoteScope(ctx, req)
	if g.Agent != "" {
		req.Agent = g.Agent
	}
	if g.Device != "" {
		req.DeviceName = g.Device
	}
	if IsInteractive() && !g.JSON {
		fmt.Fprintln(os.Stderr, render.ContextLine(render.ContextLineOptions{
			Command:    "analytics",
			Source:     "remote",
			Scope:      scope,
			ScopeLabel: scopeLabel,
			Last:       w.LastLabel,
			Since:      w.SinceLabel,
			Between:    w.BetweenLabel,
		}))
	}
	client := rpc.Analytics(auth.Server, auth.Token)
	resp, err := client.GetReport(ctx, connect.NewRequest(req))
	if err != nil {
		return fmt.Errorf("analytics rpc: %s", rpc.ConnectError(err))
	}
	result := analyticsProtoResult(resp.Msg)
	if g.JSON {
		return emitAnalyticsJSON(os.Stdout, result)
	}
	return render.Analytics(os.Stdout, result, IsInteractive())
}

func applyAnalyticsRemoteScope(ctx context.Context, req *prosav1.GetReportRequest) (render.ContextScope, string) {
	switch {
	case g.Project != "":
		req.ProjectMatch = g.Project
		return render.ScopeScoped, g.Project
	case g.All:
		return render.ScopeAll, ""
	default:
		if cwd, err := os.Getwd(); err == nil {
			storePath, perr := paths.StorePath()
			if perr == nil {
				s, oerr := store.OpenReadOnly(ctx, storePath)
				if oerr == nil {
					if m, derr := DetectProject(ctx, cwd, s); derr == nil && m.Found {
						switch {
						case m.Remote != "":
							req.ProjectRemote = m.Remote
						case m.Marker != "":
							req.ProjectMarker = m.Marker
						case m.Path != "":
							req.ProjectPath = m.Path
						}
						_ = s.Close()
						return render.ScopeScoped, m.HintLabel()
					}
					_ = s.Close()
				}
			}
		}
		return render.ScopeProjectNotDetected, ""
	}
}

func analyticsProtoResult(resp *prosav1.GetReportResponse) store.AnalyticsResult {
	out := store.AnalyticsResult{Headers: resp.Headers}
	for _, row := range resp.Rows {
		values := make([]any, len(row.Values))
		for i, v := range row.Values {
			values[i] = v
		}
		out.Rows = append(out.Rows, store.AnalyticsRow{Values: values})
	}
	return out
}

// emitAnalyticsJSON writes one JSON object per row, mapping each
// Header (lowercased) to its corresponding value. Numeric strings are
// passed through unchanged — downstream tools (jq, sqlite) handle
// the parse if needed.
func emitAnalyticsJSON(w *os.File, r store.AnalyticsResult) error {
	enc := json.NewEncoder(w)
	for _, row := range r.Rows {
		obj := make(map[string]any, len(r.Headers))
		for i, h := range r.Headers {
			obj[strings.ToLower(h)] = row.Values[i]
		}
		if err := enc.Encode(obj); err != nil {
			return err
		}
	}
	return nil
}
