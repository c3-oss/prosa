package cli

import (
	"context"
	"os"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/store"
)

// ProjectScope is the resolved project scope for read commands.
type ProjectScope struct {
	Scope   render.ContextScope
	Label   string
	Project string
	Match   Match
}

func ResolveProjectScope(ctx context.Context, flags globalFlags, s *store.Store) ProjectScope {
	switch {
	case flags.Project != "":
		return ProjectScope{Scope: render.ScopeScoped, Label: flags.Project, Project: flags.Project}
	case flags.All:
		return ProjectScope{Scope: render.ScopeAll}
	default:
		scope := ProjectScope{Scope: render.ScopeProjectNotDetected}
		cwd, err := os.Getwd()
		if err != nil || s == nil {
			return scope
		}
		m, err := DetectProject(ctx, cwd, s)
		if err != nil || !m.Found {
			return scope
		}
		return ProjectScope{Scope: render.ScopeScoped, Label: m.HintLabel(), Match: m}
	}
}

func ResolveProjectScopeFromLocalStore(ctx context.Context, flags globalFlags) ProjectScope {
	if flags.Project != "" || flags.All {
		return ResolveProjectScope(ctx, flags, nil)
	}
	storePath, err := paths.StorePath()
	if err != nil {
		return ProjectScope{Scope: render.ScopeProjectNotDetected}
	}
	s, err := store.OpenReadOnly(ctx, storePath)
	if err != nil {
		return ProjectScope{Scope: render.ScopeProjectNotDetected}
	}
	defer func() { _ = s.Close() }()
	return ResolveProjectScope(ctx, flags, s)
}

func (s ProjectScope) ApplySessionFilter(filter *store.SessionFilter) {
	if s.Project != "" {
		p := s.Project
		filter.ProjectMatch = &p
		return
	}
	if s.Match.Found {
		applyMatchFilter(filter, s.Match)
	}
}

func (s ProjectScope) ApplyReportRequest(req *prosav1.GetReportRequest) {
	if s.Project != "" {
		req.ProjectMatch = s.Project
		return
	}
	switch {
	case s.Match.Remote != "":
		req.ProjectRemote = s.Match.Remote
	case s.Match.Marker != "":
		req.ProjectMarker = s.Match.Marker
	case s.Match.Path != "":
		req.ProjectPath = s.Match.Path
	}
}

func (s ProjectScope) ApplySearchRequest(req *prosav1.SearchRequest) {
	switch {
	case s.Match.Remote != "":
		req.ProjectRemote = s.Match.Remote
	case s.Match.Marker != "":
		req.ProjectMarker = s.Match.Marker
	}
}
