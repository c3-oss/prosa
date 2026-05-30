package cli

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/c3-oss/prosa/internal/projectid"
	"github.com/c3-oss/prosa/internal/store"
)

// Match is the resolved auto-filter target. Exactly one of Remote/Marker/Path
// is populated; callers use that to choose which SessionFilter dimension to
// set. When none matches, Found is false.
type Match struct {
	Remote string
	Marker string
	Path   string
	Found  bool
}

// DetectProject resolves the project to auto-filter the timeline by,
// honoring INTENT.md §5 in priority order:
//
//  1. If `git remote get-url origin` works in cwd AND the store has at
//     least one session with that remote, use it.
//  2. Else if a .prosa.yaml is reachable from cwd AND the store has a
//     session with that marker, use it.
//  3. Else fall back to the legacy "longest project_path ancestor"
//     heuristic (kept so users without git or markers still get
//     auto-scoping in the directories they actually work in).
//
// Returns Match{Found: false} when nothing matches.
func DetectProject(ctx context.Context, cwd string, s *store.Store) (Match, error) {
	id := projectid.Resolve(cwd)

	if id.Remote != nil {
		ok, err := s.ProjectRemoteExists(ctx, *id.Remote)
		if err != nil {
			return Match{}, err
		}
		if ok {
			return Match{Remote: *id.Remote, Found: true}, nil
		}
	}
	if id.Marker != nil {
		ok, err := s.ProjectMarkerExists(ctx, *id.Marker)
		if err != nil {
			return Match{}, err
		}
		if ok {
			return Match{Marker: *id.Marker, Found: true}, nil
		}
	}
	if path, ok := detectByPath(ctx, cwd, s); ok {
		return Match{Path: path, Found: true}, nil
	}
	return Match{}, nil
}

// detectByPath is the original substring-ancestor matcher. Used as the
// final fallback when neither git remote nor .prosa.yaml resolves.
func detectByPath(ctx context.Context, cwd string, s *store.Store) (string, bool) {
	paths, err := s.DistinctProjectPaths(ctx)
	if err != nil {
		return "", false
	}
	cwd = filepath.Clean(cwd)
	sort.Slice(paths, func(i, j int) bool { return len(paths[i]) > len(paths[j]) })
	for _, p := range paths {
		clean := filepath.Clean(p)
		if cwd == clean {
			return clean, true
		}
		if strings.HasPrefix(cwd, clean+string(os.PathSeparator)) {
			return clean, true
		}
	}
	return "", false
}

// applyMatchFilter copies the populated dimension of m into the
// SessionFilter so the query layer filters by exactly one identity
// field. Caller must ensure m.Found before calling.
func applyMatchFilter(f *store.SessionFilter, m Match) {
	switch {
	case m.Remote != "":
		v := m.Remote
		f.ProjectRemote = &v
	case m.Marker != "":
		v := m.Marker
		f.ProjectMarker = &v
	case m.Path != "":
		v := m.Path
		f.ProjectExact = &v
	}
}

// HintLabel renders a short human label for a Match — used in the
// status hint printed at the top of the timeline.
func (m Match) HintLabel() string {
	switch {
	case m.Remote != "":
		return m.Remote
	case m.Marker != "":
		return m.Marker + " (.prosa.yaml)"
	case m.Path != "":
		return m.Path
	}
	return ""
}
