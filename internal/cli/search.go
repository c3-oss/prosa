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
	"github.com/c3-oss/prosa/pkg/session"
)

const defaultSearchLimit = 20

var searchLimit int

func newSearchCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "search <query>",
		Short: "Search session content via FTS5",
		Long: "Searches user and assistant text across all imported sessions using " +
			"the FTS5 index populated at import time. Query syntax is SQLite FTS5 " +
			"(supports AND, OR, NEAR, prefix*, etc.). Inherits the global filter " +
			"flags (--project / --agent / --device / --last); --all disables the " +
			"cwd auto-filter the same way it does for the bare timeline.\n\n" +
			"Pass --remote (a persistent flag) to query the prosa-server's Postgres " +
			"FTS instead of the local SQLite FTS5; requires `prosa login`.",
		Args: cobra.MinimumNArgs(1),
		RunE: runSearch,
	}
	cmd.Flags().IntVar(&searchLimit, "limit", defaultSearchLimit, "maximum number of session hits to return")
	return cmd
}

func runSearch(cmd *cobra.Command, args []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	query := strings.TrimSpace(strings.Join(args, " "))
	if query == "" {
		return errors.New("empty search query")
	}

	now := time.Now().UTC()
	w, err := ResolveWindow(cmd, g.Last, g.Since, g.Between, now)
	if err != nil {
		return err
	}
	limit, err := effectiveSearchLimit(cmd)
	if err != nil {
		return err
	}

	if g.Remote {
		return runSearchRemote(ctx, query, w, limit)
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

	interactive := IsInteractive()
	filter := store.SessionFilter{
		Since: w.Since,
		Until: w.Until,
	}

	projectScope := ResolveProjectScope(ctx, g, s)
	projectScope.ApplySessionFilter(&filter)
	if interactive && !g.JSON {
		fmt.Fprintln(os.Stderr, render.SearchContextLine(render.ContextLineOptions{
			Command:    "search",
			Source:     "local",
			Scope:      projectScope.Scope,
			ScopeLabel: projectScope.Label,
			Query:      query,
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

	hits, err := s.Search(ctx, query, filter, limit)
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
		if interactive {
			fmt.Fprintln(os.Stderr, "no matches")
			fmt.Fprintln(os.Stderr, "try `--all`, widen the window, or search a broader term")
			return nil
		}
		fmt.Fprintf(os.Stderr, "no matches for %q\n", query)
		return nil
	}
	deviceLabels, _ := s.ListDevicesMap(ctx)
	hideDevice := countDistinctDevices(hits) <= 1
	hideProject := projectScope.Scope == render.ScopeScoped && countDistinctProjects(hits) <= 1
	return render.SearchHitsWithOptions(os.Stdout, hits, now, render.SearchOptions{
		Interactive:  interactive,
		Width:        TerminalWidth(),
		DeviceLabels: deviceLabels,
		HideDevice:   hideDevice,
		HideProject:  hideProject,
	})
}

// countDistinctDevices / countDistinctProjects collapse a hit list
// into the number of distinct device_ids / project labels so the
// renderer can drop the column when cardinality is 1.
func countDistinctDevices(hits []store.SearchHit) int {
	seen := map[string]struct{}{}
	for _, h := range hits {
		seen[h.Session.DeviceID] = struct{}{}
	}
	return len(seen)
}

func countDistinctProjects(hits []store.SearchHit) int {
	seen := map[string]struct{}{}
	for _, h := range hits {
		p := ""
		switch {
		case h.Session.ProjectMarker != nil && *h.Session.ProjectMarker != "":
			p = *h.Session.ProjectMarker
		case h.Session.ProjectPath != nil:
			p = *h.Session.ProjectPath
		case h.Session.ProjectRemote != nil:
			p = *h.Session.ProjectRemote
		}
		seen[p] = struct{}{}
	}
	return len(seen)
}

func effectiveSearchLimit(cmd *cobra.Command) (int, error) {
	limit := searchLimit
	if cmd != nil {
		searchFlag := cmd.Flags().Lookup("limit")
		if searchFlag == nil || !searchFlag.Changed {
			if root := cmd.Root(); root != nil {
				if rootFlag := root.Flags().Lookup("limit"); rootFlag != nil && rootFlag.Changed {
					limit = g.Limit
				}
			}
		}
	}
	if limit < 0 {
		return 0, fmt.Errorf("--limit must be >= 0")
	}
	if limit == 0 {
		return defaultSearchLimit, nil
	}
	return limit, nil
}

// runSearchRemote talks to Sessions.Search and projects the response
// into the same store.SearchHit shape the renderer expects. The remote
// path honors --agent / --device and the auto-detected --project, but
// translates them to project_remote / project_marker filters since the
// server doesn't have project_path substring semantics today.
func runSearchRemote(ctx context.Context, query string, w Window, limit int) error {
	auth, err := rpc.LoadAuth()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("not logged in — run `prosa login --server <URL>` first")
		}
		return err
	}
	client := rpc.Sessions(auth.Server, auth.Token)
	interactive := IsInteractive()
	req := &prosav1.SearchRequest{
		Query: query,
		Since: timestamppb.New(w.Since),
		Until: timestamppb.New(w.Until),
		Limit: int32(limit),
	}
	if g.Agent != "" {
		req.Agent = g.Agent
	}
	if g.Device != "" {
		req.DeviceName = g.Device
	}
	// Project identity: prefer git remote / marker; the substring
	// --project flag stays local-only because the server doesn't
	// expose ILIKE search to clients.
	projectScope := ResolveProjectScopeFromLocalStore(ctx, g)
	projectScope.ApplySearchRequest(req)
	if interactive && !g.JSON {
		fmt.Fprintln(os.Stderr, render.SearchContextLine(render.ContextLineOptions{
			Command:    "search",
			Source:     "remote",
			Scope:      projectScope.Scope,
			ScopeLabel: projectScope.Label,
			Query:      query,
		}))
	}
	resp, err := client.Search(ctx, connect.NewRequest(req))
	if err != nil {
		return fmt.Errorf("search rpc: %s", rpc.ConnectError(err))
	}
	hits := remoteHitsToLocal(resp.Msg.Hits)
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
		if interactive {
			fmt.Fprintln(os.Stderr, "no matches")
			fmt.Fprintln(os.Stderr, "try `--all`, widen the window, or search a broader term")
			return nil
		}
		fmt.Fprintf(os.Stderr, "no matches for %q (remote)\n", query)
		return nil
	}
	// Remote search: open the local store JUST to fetch device labels,
	// so the hit rows render with friendly_names rather than the raw
	// fingerprints embedded in the wire response.
	var deviceLabels map[string]string
	if storePath, perr := paths.StorePath(); perr == nil {
		if s, oerr := store.OpenReadOnly(ctx, storePath); oerr == nil {
			deviceLabels, _ = s.ListDevicesMap(ctx)
			_ = s.Close()
		}
	}
	hideDevice := countDistinctDevices(hits) <= 1
	hideProject := projectScope.Scope == render.ScopeScoped && countDistinctProjects(hits) <= 1
	return render.SearchHitsWithOptions(os.Stdout, hits, w.Until, render.SearchOptions{
		Interactive:  interactive,
		Width:        TerminalWidth(),
		DeviceLabels: deviceLabels,
		HideDevice:   hideDevice,
		HideProject:  hideProject,
	})
}

// remoteHitsToLocal converts the proto wire shape into the local
// SearchHit struct the renderer was written against.
func remoteHitsToLocal(in []*prosav1.SearchHit) []store.SearchHit {
	out := make([]store.SearchHit, 0, len(in))
	for _, h := range in {
		s := session.Session{
			ID:             h.Session.Id,
			Agent:          h.Session.Agent,
			DeviceID:       h.Session.DeviceId,
			StartedAt:      h.Session.StartedAt.AsTime(),
			LastActivityAt: h.Session.LastActivityAt.AsTime(),
			RawPath:        h.Session.RawUri,
			RawHash:        h.Session.RawHash,
			RawSize:        h.Session.RawSize,
		}
		if h.Session.ProjectPath != "" {
			v := h.Session.ProjectPath
			s.ProjectPath = &v
		}
		if h.Session.ProjectRemote != "" {
			v := h.Session.ProjectRemote
			s.ProjectRemote = &v
		}
		if h.Session.ProjectMarker != "" {
			v := h.Session.ProjectMarker
			s.ProjectMarker = &v
		}
		if h.Session.FirstPrompt != "" {
			v := h.Session.FirstPrompt
			s.FirstPrompt = &v
		}
		if h.Session.Model != "" {
			v := h.Session.Model
			s.Model = &v
		}
		hit := store.SearchHit{
			Session:    s,
			Snippet:    h.Snippet,
			Role:       h.Role,
			TurnID:     h.TurnId,
			Kind:       h.Kind,
			ToolName:   h.ToolName,
			MatchField: h.MatchField,
			Rank:       h.Rank,
		}
		if h.TurnTs != nil {
			hit.TurnTS = h.TurnTs.AsTime()
		}
		out = append(out, hit)
	}
	return out
}
