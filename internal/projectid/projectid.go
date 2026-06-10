// Package projectid resolves the canonical identity of the project a
// prosa session ran in. See INTENT.md §5 for the contract:
//
//  1. `git remote get-url origin` on the session's cwd → canonical URL.
//     Stable cross-device: two clones of the same repo on two machines
//     end up with the same project_remote.
//  2. .prosa.yaml in cwd or any ancestor, with `project: <name>` → marker.
//     Explicit override for repos without a shared remote (private vendor
//     drops, monorepos with per-subdir projects, …).
//  3. cwd itself, marked "unscoped" — last fallback. Visible in the
//     timeline but never the basis of auto-filter.
//
// Resolve fails soft: missing git binary, unreadable .prosa.yaml, or a
// path that simply isn't a repo all yield Identity{Path: cwd} with no
// error. Callers only have to inspect the populated pointers to decide
// which dimension matched.
package projectid

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/c3-oss/prosa/pkg/session"
)

// Identity is the resolved triple. At least Path is always populated.
type Identity struct {
	// Remote is the canonical `git remote get-url origin` URL when the
	// session's cwd resolves as a git repo. nil otherwise.
	Remote *string

	// Marker is the `project:` value from the nearest .prosa.yaml. nil
	// when no marker file is reachable.
	Marker *string

	// Path is the session's cwd, normalized (filepath.Clean) — useful as
	// the universal fallback for display and the legacy substring filter.
	Path string
}

// gitTimeout caps the subprocess wall-clock; under load (network FS,
// hibernating disk) a stray `git remote` can hang.
const gitTimeout = 800 * time.Millisecond

// markerFile is the filename searched in cwd and every ancestor up to
// the filesystem root (or a git toplevel, whichever comes first).
const markerFile = ".prosa.yaml"

// Apply populates sess.ProjectRemote / sess.ProjectMarker from
// Resolve(*sess.ProjectPath). No-op when ProjectPath is nil.
func Apply(sess *session.Session) {
	if sess == nil || sess.ProjectPath == nil || *sess.ProjectPath == "" {
		return
	}
	id := Resolve(*sess.ProjectPath)
	if id.Remote != nil {
		v := *id.Remote
		sess.ProjectRemote = &v
	}
	if id.Marker != nil {
		v := *id.Marker
		sess.ProjectMarker = &v
	}
}

// Resolve produces the Identity for the given cwd. A non-existent cwd
// (legacy bundle path on a different machine) is returned as
// Identity{Path: cleaned} — Remote/Marker stay nil.
func Resolve(cwd string) Identity {
	cwd = filepath.Clean(cwd)
	id := Identity{Path: cwd}

	if _, err := os.Stat(cwd); err != nil {
		return id
	}

	if r, ok := gitRemote(cwd); ok {
		s := r
		id.Remote = &s
	}
	if m, ok := markerWalk(cwd); ok {
		s := m
		id.Marker = &s
	}
	return id
}

// gitRemote runs `git -C <cwd> remote get-url origin` with a short timeout.
func gitRemote(cwd string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", cwd, "remote", "get-url", "origin")
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	v := strings.TrimSpace(string(out))
	if v == "" {
		return "", false
	}
	return v, true
}

// markerWalk searches for .prosa.yaml from cwd upward, stopping at the
// filesystem root.
func markerWalk(cwd string) (string, bool) {
	dir := cwd
	for {
		path := filepath.Join(dir, markerFile)
		if name, ok := readProjectKey(path); ok && name != "" {
			return name, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

// readProjectKey scans the file for a single `project: <name>` entry.
// Hand-rolled to avoid the yaml.v3 dependency; INTENT.md only promises
// the `project:` key for v3.
//
// Accepted forms (the value is everything after the colon, trimmed of
// quotes and whitespace; an inline `# comment` is stripped):
//
//	project: foo
//	project: "foo bar"
//	project: 'foo'   # leading marker
//
// Lines starting with `#` and blank lines are ignored. Unknown keys
// are silently skipped.
func readProjectKey(path string) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		const prefix = "project:"
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		val := strings.TrimSpace(line[len(prefix):])
		if i := strings.IndexByte(val, '#'); i >= 0 {
			val = strings.TrimSpace(val[:i])
		}
		val = strings.Trim(val, `"' `)
		if val == "" {
			continue
		}
		return val, true
	}
	if err := sc.Err(); err != nil && !errors.Is(err, bytes.ErrTooLarge) {
		return "", false
	}
	return "", false
}
