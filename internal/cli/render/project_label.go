package render

import (
	"path"
	"strings"

	"github.com/c3-oss/prosa/pkg/session"
)

const unscopedProjectLabel = "(unscoped)"

// NormalizeRemote collapses a git remote URL down to "owner/repo" form.
// Anything that does not look like a URL is returned as-is so callers
// preserve best-effort project information instead of dropping data.
func NormalizeRemote(remote string) string {
	r := strings.TrimSpace(remote)
	if r == "" {
		return ""
	}

	switch {
	case strings.HasPrefix(r, "git@"):
		if i := strings.Index(r, ":"); i >= 0 {
			r = r[i+1:]
		}
	case strings.HasPrefix(r, "ssh://"):
		r = strings.TrimPrefix(r, "ssh://")
		if i := strings.Index(r, "/"); i >= 0 {
			r = r[i+1:]
		}
	case strings.HasPrefix(r, "https://"), strings.HasPrefix(r, "http://"):
		r = strings.TrimPrefix(r, "https://")
		r = strings.TrimPrefix(r, "http://")
		if i := strings.Index(r, "/"); i >= 0 {
			r = r[i+1:]
		}
	}

	r = strings.TrimSuffix(r, ".git")
	r = strings.Trim(r, "/")
	return r
}

// projectLabel returns the compact display name used in CLI project columns:
// marker, normalized remote, basename of path, then "(unscoped)".
func projectLabel(s session.Session) string {
	if v := stringPtrValue(s.ProjectMarker); v != "" {
		return v
	}
	if v := stringPtrValue(s.ProjectRemote); v != "" {
		if n := NormalizeRemote(v); n != "" {
			return n
		}
	}
	if v := stringPtrValue(s.ProjectPath); v != "" {
		base := path.Base(v)
		if base != "." && base != "/" && base != "" {
			return base
		}
	}
	return unscopedProjectLabel
}

func stringPtrValue(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}
