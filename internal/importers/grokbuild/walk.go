package grokbuild

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
)

// sessionDirRE matches the uuidv7 directory names Grok Build assigns to
// sessions. Anchoring on the full basename keeps the walk from picking
// up `session_search.sqlite*`, `prompt_history.jsonl`, lock files, or
// any other project-level clutter.
var sessionDirRE = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
)

// Walk discovers Grok Build session anchors under root. The layout is
// `<root>/<percent-encoded-cwd>/<uuidv7>/summary.json` — exactly depth
// 3, so `subagents/`, `terminal/`, and other nested directories are
// structurally excluded.
//
// A missing root returns an empty slice with no error — typical for
// machines that never installed Grok Build.
func (i *Importer) Walk(ctx context.Context, root string) ([]string, error) {
	projects, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var out []string
	for _, project := range projects {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !project.IsDir() {
			continue
		}
		projectDir := filepath.Join(root, project.Name())
		sessions, err := os.ReadDir(projectDir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		for _, sess := range sessions {
			if !sess.IsDir() || !sessionDirRE.MatchString(sess.Name()) {
				continue
			}
			anchor := filepath.Join(projectDir, sess.Name(), "summary.json")
			if _, err := os.Stat(anchor); err != nil {
				continue
			}
			out = append(out, anchor)
		}
	}
	return out, nil
}
