// Package projectlabel derives the human-facing project name from the
// raw project_path / project_remote / project_marker fields stored on
// each session. Centralized so timeline, search, show, and analytics
// renderers all agree on which label to display — the raw columns stay
// available in JSON for scripts.
package projectlabel

import (
	"path"
	"strings"

	"github.com/c3-oss/prosa/pkg/session"
)

// Unscoped is the placeholder rendered when a session has no path,
// remote, or marker we can derive a label from.
const Unscoped = "(unscoped)"

// Normalize collapses a git remote URL down to "owner/repo" form.
// Recognized inputs:
//
//	git@github.com:owner/repo.git
//	git@github.com:owner/repo
//	ssh://git@github.com/owner/repo.git
//	https://github.com/owner/repo.git
//	https://github.com/owner/repo
//	http://gitlab.com/group/sub/repo (subgroup paths pass through unchanged)
//
// Anything that doesn't look like a URL is returned as-is (best effort
// — callers fall back to the raw value rather than dropping data).
func Normalize(remote string) string {
	r := strings.TrimSpace(remote)
	if r == "" {
		return ""
	}

	switch {
	case strings.HasPrefix(r, "git@"):
		// git@host:owner/repo(.git)
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

// Label returns the canonical display name for a session, in
// preference order:
//
//  1. project_marker (explicit .prosa.yaml override);
//  2. normalized project_remote (cross-device stable);
//  3. basename of project_path (best local hint);
//  4. Unscoped.
//
// Callers that want the raw values should read them off the Session
// directly; this function intentionally drops detail to fit a terminal
// column.
func Label(s session.Session) string {
	if v := strDeref(s.ProjectMarker); v != "" {
		return v
	}
	if v := strDeref(s.ProjectRemote); v != "" {
		if n := Normalize(v); n != "" {
			return n
		}
	}
	if v := strDeref(s.ProjectPath); v != "" {
		base := path.Base(v)
		if base != "." && base != "/" && base != "" {
			return base
		}
	}
	return Unscoped
}

func strDeref(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}
