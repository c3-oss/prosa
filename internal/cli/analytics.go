package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
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

var validAnalyticsReports = []string{"sessions", "tools", "models", "projects", "profiles", "errors", "heatmap", "usage", "hours", "usage_by_model", "errors_by_model", "subagents"}

func newAnalyticsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "analytics <report>",
		Short: "Run a built-in report over your sessions",
		Long: "Available reports:\n" +
			"  sessions         sessions and turn totals by agent\n" +
			"  tools            most-used tools (top 20)\n" +
			"  models           sessions per model\n" +
			"  projects         sessions per project, grouped by agent\n" +
			"  profiles         sessions per profile, grouped by agent\n" +
			"  heatmap          daily session count, fixed to the trailing year\n" +
			"  usage            tokens and estimated USD cost by agent\n" +
			"  errors           sessions whose assistant turns look like failures\n" +
			"  hours            sessions per UTC hour of day (00–23)\n" +
			"  usage_by_model   tokens and estimated USD cost by model\n" +
			"  errors_by_model  flagged sessions by model\n" +
			"  subagents        subagent fan-out per parent agent\n\n" +
			"All reports honor the global filters. heatmap rejects --last, --since, and --between.",
		ValidArgs: validAnalyticsReports,
		Args:      cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs),
		RunE:      runAnalytics,
	}
}

func runAnalytics(cmd *cobra.Command, args []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	report := args[0]

	now := time.Now().UTC()
	var w Window
	if report == "heatmap" {
		if cmd.Flags().Changed("last") || cmd.Flags().Changed("since") || cmd.Flags().Changed("between") {
			return errors.New("heatmap covers the trailing 53 weeks; --last, --since, and --between are not accepted")
		}
		w = HeatmapWindow(now)
	} else {
		var err error
		w, err = ResolveWindow(cmd, g.Last, g.Since, g.Between, now)
		if err != nil {
			return err
		}
	}

	if g.Remote {
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
	projectScope := ResolveProjectScope(ctx, g, s)
	projectScope.ApplySessionFilter(&filter)
	if g.Agent != "" {
		a := g.Agent
		filter.Agent = &a
	}
	if g.Device != "" {
		d := g.Device
		filter.DeviceName = &d
	}
	if g.Profile != "" {
		p := g.Profile
		filter.Profile = &p
	}
	if IsInteractive() && !g.JSON {
		fmt.Fprintln(os.Stderr, render.ContextLine(render.ContextLineOptions{
			Command:    "analytics",
			Source:     "local",
			Scope:      projectScope.Scope,
			ScopeLabel: projectScope.Label,
			Last:       w.LastSegment(),
			Since:      w.SinceLabel,
			Between:    w.BetweenLabel,
		}))
	}

	result, err := dispatchAnalytics(ctx, s, report, filter)
	if err != nil {
		return err
	}
	result = rollupHeatmapForDisplay(report, result)

	if g.JSON {
		return emitAnalyticsJSON(os.Stdout, result)
	}
	return render.Analytics(os.Stdout, result, IsInteractive())
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
	case "profiles":
		return s.AnalyticsProfiles(ctx, f)
	case "errors":
		return s.AnalyticsErrors(ctx, f)
	case "heatmap":
		return s.AnalyticsHeatmap(ctx, f)
	case "usage":
		return s.AnalyticsUsage(ctx, f)
	case "hours":
		return s.AnalyticsHours(ctx, f)
	case "usage_by_model":
		return s.AnalyticsUsageByModel(ctx, f)
	case "errors_by_model":
		return s.AnalyticsErrorsByModel(ctx, f)
	case "subagents":
		return s.AnalyticsSubagents(ctx, f)
	default:
		return store.AnalyticsResult{}, fmt.Errorf("unknown report: %s", report)
	}
}

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
	projectScope := ResolveProjectScopeFromLocalStore(ctx, g)
	projectScope.ApplyReportRequest(req)
	if g.Agent != "" {
		req.Agent = g.Agent
	}
	if g.Device != "" {
		req.DeviceName = g.Device
	}
	if g.Profile != "" {
		req.Profile = g.Profile
	}
	if IsInteractive() && !g.JSON {
		fmt.Fprintln(os.Stderr, render.ContextLine(render.ContextLineOptions{
			Command:    "analytics",
			Source:     "remote",
			Scope:      projectScope.Scope,
			ScopeLabel: projectScope.Label,
			Last:       w.LastSegment(),
			Since:      w.SinceLabel,
			Between:    w.BetweenLabel,
		}))
	}
	client := rpc.Analytics(auth.Server, auth.Token)
	resp, err := client.GetReport(ctx, connect.NewRequest(req))
	if err != nil {
		return fmt.Errorf("analytics rpc: %s", rpc.ConnectError(err))
	}
	result := rollupHeatmapForDisplay(report, analyticsProtoResult(resp.Msg))
	if g.JSON {
		return emitAnalyticsJSON(os.Stdout, result)
	}
	return render.Analytics(os.Stdout, result, IsInteractive())
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

// rollupHeatmapForDisplay collapses the canonical per-(day, agent) heatmap rows
// into per-day totals for the CLI table. Non-heatmap reports pass through unchanged.
func rollupHeatmapForDisplay(report string, result store.AnalyticsResult) store.AnalyticsResult {
	if report != "heatmap" || !analyticsHeadersEqual(result.Headers, []string{"DATE", "AGENT", "SESSIONS"}) {
		return result
	}

	out := store.AnalyticsResult{Headers: []string{"DATE", "SESSIONS"}}
	order := make([]string, 0, len(result.Rows))
	counts := map[string]int64{}
	for _, row := range result.Rows {
		if len(row.Values) < 3 {
			continue
		}
		date := strings.TrimSpace(fmt.Sprint(row.Values[0]))
		if date == "" {
			continue
		}
		if _, ok := counts[date]; !ok {
			order = append(order, date)
		}
		counts[date] += parseAnalyticsCount(row.Values[2])
	}
	for _, date := range order {
		out.Rows = append(out.Rows, store.AnalyticsRow{
			Values: []any{date, strconv.FormatInt(counts[date], 10)},
		})
	}
	return out
}

func analyticsHeadersEqual(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func parseAnalyticsCount(v any) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(fmt.Sprint(v)), 10, 64)
	return n
}

// emitAnalyticsJSON writes one JSON object per row with lowercased header keys.
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
