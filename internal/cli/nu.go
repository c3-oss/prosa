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

	now := time.Now().UTC()
	w, err := ResolveWindow(cmd, g.Last, g.Since, g.Between, now)
	if err != nil {
		return err
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

	interactive := IsInteractive()
	filter := store.SessionFilter{
		Since: w.Since,
		Until: w.Until,
	}
	var scope render.ContextScope
	scopeLabel := ""

	switch {
	case g.Project != "":
		p := g.Project
		filter.ProjectMatch = &p
		scope = render.ScopeScoped
		scopeLabel = p
	case g.All:
		scope = render.ScopeAll
	default:
		// No --project, no --all: attempt auto-detect from cwd.
		scope = render.ScopeProjectNotDetected
		cwd, err := os.Getwd()
		if err == nil {
			if m, err := DetectProject(ctx, cwd, s); err == nil && m.Found {
				applyMatchFilter(&filter, m)
				scope = render.ScopeScoped
				scopeLabel = m.HintLabel()
			}
		}
	}

	if interactive && !g.JSON {
		fmt.Fprintln(os.Stderr, render.ContextLine(render.ContextLineOptions{
			Command:    "prosa",
			Source:     "local",
			Scope:      scope,
			ScopeLabel: scopeLabel,
			Last:       w.LastLabel,
			Since:      w.SinceLabel,
			Between:    w.BetweenLabel,
		}))
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
		// Empty state goes to stderr — stdout stays clean so
		// `prosa | wc -l` returns 0 and `prosa | jq` doesn't choke.
		if interactive {
			if scopeLabel != "" {
				fmt.Fprintf(os.Stderr, "no sessions found for %s\n", scopeLabel)
				fmt.Fprintln(os.Stderr, "use `prosa --all` to show every project")
				return nil
			}
			fmt.Fprintln(os.Stderr, "no sessions found")
			fmt.Fprintln(os.Stderr, "run `prosa sync` to import local agent history")
			return nil
		}
		fmt.Fprintf(os.Stderr, "no sessions %s\n", WindowDescriptor(w))
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
	deviceLabels, derr := s.ListDevicesMap(ctx)
	if derr != nil {
		deviceLabels = nil // render falls back to truncated hex
	}
	return render.TimelineItems(os.Stdout, items, now, render.TimelineOptions{
		Interactive:  interactive,
		Width:        TerminalWidth(),
		Layout:       layout,
		Slots:        render.ResolveSlots(items, layout),
		DeviceLabels: deviceLabels,
	})
}
