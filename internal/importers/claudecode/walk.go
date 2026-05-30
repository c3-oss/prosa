package claudecode

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// uuidFileRE matches the UUID-shaped basename Claude Code uses for main
// session JSONL files (e.g. "01234567-89ab-4cde-9012-3456789abcde.jsonl").
// The regex is intentionally tolerant on the version nibble (could be any
// hex) because we don't want to depend on Claude Code locking UUIDv4.
var uuidFileRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$`)

// Walk discovers main session JSONL files under root. It skips:
//   - any directory named `subagents`, `memory`, or `tool-results`
//   - files whose basename does not match the UUID-jsonl pattern
//     (excludes sessions-index.json, hand-edited *.jsonl, etc.)
//   - subagent files even if reached via a path containing /subagents/
//     (defense-in-depth in case the SkipDir didn't match a non-standard
//     layout).
//
// A missing root returns an empty slice with no error — typical for
// machines that never installed Claude Code.
func (i *Importer) Walk(ctx context.Context, root string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if d.IsDir() {
			switch d.Name() {
			case "subagents", "memory", "tool-results":
				return fs.SkipDir
			}
			return nil
		}
		if strings.Contains(filepath.ToSlash(path), "/subagents/") {
			return nil
		}
		if !uuidFileRE.MatchString(d.Name()) {
			return nil
		}
		out = append(out, path)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
