package cli

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/c3-oss/prosa/internal/store"
)

// DetectProject returns the longest project_path in the store that is
// either equal to cwd or an ancestor of it. "Longest wins" handles
// nested workspaces correctly: invoking `prosa` from `~/foo/bar/sub`
// chooses `~/foo/bar` over a higher `~/foo` if both are known projects.
// Returns ("", false, nil) when no project_path matches.
func DetectProject(ctx context.Context, cwd string, s *store.Store) (string, bool, error) {
	paths, err := s.DistinctProjectPaths(ctx)
	if err != nil {
		return "", false, err
	}
	cwd = filepath.Clean(cwd)
	sort.Slice(paths, func(i, j int) bool { return len(paths[i]) > len(paths[j]) })
	for _, p := range paths {
		clean := filepath.Clean(p)
		if cwd == clean {
			return clean, true, nil
		}
		if strings.HasPrefix(cwd, clean+string(os.PathSeparator)) {
			return clean, true, nil
		}
	}
	return "", false, nil
}
