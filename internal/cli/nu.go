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
	interactive := IsInteractive()
	filter := store.SessionFilter{
		Since: now.Add(-window),
		Until: now,
	}
	scopeLabel := ""

	switch {
	case g.Project != "":
		p := g.Project
		filter.ProjectMatch = &p
		scopeLabel = p
	case !g.All:
		cwd, err := os.Getwd()
		if err == nil {
			if m, err := DetectProject(ctx, cwd, s); err == nil && m.Found {
				applyMatchFilter(&filter, m)
				scopeLabel = m.HintLabel()
				if interactive && !g.JSON {
					fmt.Fprintf(os.Stderr, "prosa · local · scoped to %s · last %s\n", scopeLabel, g.Last)
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
		if interactive {
			if scopeLabel != "" {
				fmt.Fprintf(os.Stdout, "no sessions found for %s\n", scopeLabel)
				fmt.Fprintln(os.Stdout, "use `prosa --all` to show every project")
				return nil
			}
			fmt.Fprintln(os.Stdout, "no sessions found")
			fmt.Fprintln(os.Stdout, "run `prosa sync` to import local agent history")
			return nil
		}
		fmt.Fprintf(os.Stdout, "no sessions in the last %s\n", g.Last)
		return nil
	}

	items := make([]render.TimelineItem, len(sessions))
	for i := range sessions {
		tools, err := s.GetSessionTools(ctx, sessions[i].ID)
		if err != nil {
			return err
		}
		items[i] = render.TimelineItem{Session: sessions[i], Tools: tools}
	}
	layout := render.TimelineGlobal
	if g.Project != "" || filter.ProjectExact != nil || filter.ProjectRemote != nil || filter.ProjectMarker != nil {
		layout = render.TimelineScoped
	}
	return render.TimelineItems(os.Stdout, items, now, render.TimelineOptions{
		Interactive: interactive,
		Width:       TerminalWidth(),
		Layout:      layout,
	})
}
