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

var searchLimit int

func newSearchCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "search <query>",
		Short: "Search session content via FTS5",
		Long: "Searches user and assistant text across all imported sessions using " +
			"the FTS5 index populated at import time. Query syntax is SQLite FTS5 " +
			"(supports AND, OR, NEAR, prefix*, etc.). Inherits the global filter " +
			"flags (--project / --agent / --device / --last); --all disables the " +
			"cwd auto-filter the same way it does for the bare timeline.",
		Args: cobra.MinimumNArgs(1),
		RunE: runSearch,
	}
	cmd.Flags().IntVar(&searchLimit, "limit", 20, "maximum number of session hits to return")
	return cmd
}

func runSearch(cmd *cobra.Command, args []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	query := strings.TrimSpace(strings.Join(args, " "))
	if query == "" {
		return fmt.Errorf("empty search query")
	}

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

	switch {
	case g.Project != "":
		p := g.Project
		filter.ProjectMatch = &p
	case !g.All:
		cwd, err := os.Getwd()
		if err == nil {
			if detected, found, _ := DetectProject(ctx, cwd, s); found {
				filter.ProjectExact = &detected
				if !g.JSON {
					fmt.Fprintf(os.Stderr, "(scoped to: %s — use --all to search everywhere)\n", detected)
				}
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

	hits, err := s.Search(ctx, query, filter, searchLimit)
	if err != nil {
		return err
	}

	if g.JSON {
		enc := json.NewEncoder(os.Stdout)
		for i := range hits {
			if err := enc.Encode(hits[i]); err != nil {
				return err
			}
		}
		return nil
	}

	if len(hits) == 0 {
		fmt.Fprintf(os.Stdout, "no matches for %q\n", query)
		return nil
	}
	return render.SearchHits(os.Stdout, hits, now, IsInteractive())
}
