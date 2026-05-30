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

var (
	searchLimit  int
	searchRemote bool
)

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
	cmd.Flags().BoolVar(&searchRemote, "remote", false,
		"query the prosa-server's Postgres FTS instead of the local SQLite FTS5 (requires `prosa login`)")
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

	window, err := ParseLast(g.Last)
	if err != nil {
		return fmt.Errorf("--last: %w", err)
	}

	if searchRemote {
		return runSearchRemote(ctx, query, window)
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
		fmt.Fprintln(os.Stderr, render.SearchContextLine(render.ContextLineOptions{
			Command:    "search",
			Source:     "local",
			Scope:      scope,
			ScopeLabel: scopeLabel,
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
		if interactive {
			fmt.Fprintln(os.Stderr, "no matches")
			fmt.Fprintln(os.Stderr, "try `--all`, increase `--last`, or search a broader term")
			return nil
		}
		fmt.Fprintf(os.Stderr, "no matches for %q\n", query)
		return nil
	}
	deviceLabels, _ := s.ListDevicesMap(ctx)
	hideDevice := countDistinctDevices(hits) <= 1
	hideProject := scope == render.ScopeScoped && countDistinctProjects(hits) <= 1
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

// runSearchRemote talks to Sessions.Search and projects the response
// into the same store.SearchHit shape the renderer expects. The remote
// path honors --agent / --device and the auto-detected --project, but
// translates them to project_remote / project_marker filters since the
// server doesn't have project_path substring semantics today.
func runSearchRemote(ctx context.Context, query string, window time.Duration) error {
	auth, err := rpc.LoadAuth()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("not logged in — run `prosa login --server <URL>` first")
		}
		return err
	}
	client := rpc.Sessions(auth.Server, auth.Token)
	now := time.Now().UTC()
	interactive := IsInteractive()
	req := &prosav1.SearchRequest{
		Query: query,
		Since: timestamppb.New(now.Add(-window)),
		Until: timestamppb.New(now),
		Limit: int32(searchLimit),
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
	var scope render.ContextScope
	scopeLabel := ""
	switch {
	case g.Project != "":
		scope = render.ScopeScoped
		scopeLabel = g.Project
	case g.All:
		scope = render.ScopeAll
	default:
		scope = render.ScopeProjectNotDetected
		if cwd, err := os.Getwd(); err == nil {
			// Open the local store JUST to drive DetectProject — it's
			// already populated even when --remote is in play.
			storePath, perr := paths.StorePath()
			if perr == nil {
				s, oerr := store.Open(ctx, storePath)
				if oerr == nil {
					if m, derr := DetectProject(ctx, cwd, s); derr == nil && m.Found {
						switch {
						case m.Remote != "":
							req.ProjectRemote = m.Remote
						case m.Marker != "":
							req.ProjectMarker = m.Marker
						}
						scope = render.ScopeScoped
						scopeLabel = m.HintLabel()
					}
					_ = s.Close()
				}
			}
		}
	}
	if interactive && !g.JSON {
		fmt.Fprintln(os.Stderr, render.SearchContextLine(render.ContextLineOptions{
			Command:    "search",
			Source:     "remote",
			Scope:      scope,
			ScopeLabel: scopeLabel,
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
			fmt.Fprintln(os.Stderr, "try `--all`, increase `--last`, or search a broader term")
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
		if s, oerr := store.Open(ctx, storePath); oerr == nil {
			deviceLabels, _ = s.ListDevicesMap(ctx)
			_ = s.Close()
		}
	}
	hideDevice := countDistinctDevices(hits) <= 1
	hideProject := scope == render.ScopeScoped && countDistinctProjects(hits) <= 1
	return render.SearchHitsWithOptions(os.Stdout, hits, now, render.SearchOptions{
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
		out = append(out, store.SearchHit{Session: s, Snippet: h.Snippet, Role: h.Role})
	}
	return out
}
