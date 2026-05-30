package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/store"
)

// runNu implements the bare `prosa` invocation: list sessions in the
// configured window with filters applied. Default window is 7 days;
// override with --last.
//
// Filter precedence:
//  1. --project foo   → substring match on project_path; auto-detect off.
//  2. --all           → auto-detect off; no project filter.
//  3. (neither)       → auto-detect from cwd (longest matching ancestor wins).
//
// --agent / --device are independent and apply regardless.
func runNu(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
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
			if m, err := DetectProject(ctx, cwd, s); err == nil && m.Found {
				applyMatchFilter(&filter, m)
				if !g.JSON {
					fmt.Fprintf(os.Stderr, "(filtered to: %s — use --all to show everything)\n", m.HintLabel())
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

	sessions, err := s.ListSessions(ctx, filter)
	if err != nil {
		return err
	}

	if g.JSON {
		enc := json.NewEncoder(os.Stdout)
		for i := range sessions {
			if err := enc.Encode(sessions[i]); err != nil {
				return err
			}
		}
		return nil
	}

	if len(sessions) == 0 {
		fmt.Fprintf(os.Stdout, "no sessions in the last %s\n", g.Last)
		return nil
	}
	return render.Timeline(os.Stdout, sessions, now, IsInteractive())
}
