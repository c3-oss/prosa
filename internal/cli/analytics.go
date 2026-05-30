package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/store"
)

var validAnalyticsReports = []string{"sessions", "tools", "models", "projects", "errors"}

func newAnalyticsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "analytics <report>",
		Short: "Run a fixed SQL report over the local store",
		Long: "Runs one of the built-in reports against the local store. Available:\n" +
			"  sessions  — sessions and turn totals by agent\n" +
			"  tools     — most-used tools across all sessions (top 20)\n" +
			"  models    — sessions per model name\n" +
			"  projects  — sessions per project, agent-grouped (top 30)\n" +
			"  errors    — sessions whose assistant turns match common error\n" +
			"              signals via FTS5: 'error OR exception OR traceback OR panic OR fatal'\n" +
			"              (heuristic; matches the words in any context).\n\n" +
			"All reports honor the global filter flags (--last / --project / --agent /\n" +
			"--device) and emit NDJSON with --json.",
		ValidArgs: validAnalyticsReports,
		Args:      cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs),
		RunE:      runAnalytics,
	}
	return cmd
}

func runAnalytics(cmd *cobra.Command, args []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	report := args[0]

	window, err := ParseLast(g.Last)
	if err != nil {
		return fmt.Errorf("--last: %w", err)
	}
	storePath, err := paths.StorePath()
	if err != nil {
		return err
	}
	s, err := store.Open(ctx, storePath)
	if err != nil {
		return err
	}
	defer func() { _ = s.Close() }()

	now := time.Now().UTC()
	filter := store.SessionFilter{
		Since: now.Add(-window),
		Until: now,
	}
	// Analytics inherits the same filter precedence as nu / search:
	// --project wins; otherwise cwd auto-detect unless --all.
	switch {
	case g.Project != "":
		p := g.Project
		filter.ProjectMatch = &p
	case !g.All:
		cwd, err := os.Getwd()
		if err == nil {
			if m, err := DetectProject(ctx, cwd, s); err == nil && m.Found {
				applyMatchFilter(&filter, m)
			}
		}
	}
	if g.Agent != "" {
		a := g.Agent
		filter.Agent = &a
	}
	if g.Device != "" {
		d := g.Device
		filter.DeviceName = &d
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
	default:
		return store.AnalyticsResult{}, fmt.Errorf("unknown report: %s", report)
	}
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
