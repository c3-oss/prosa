package codex

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
)

// codexFileRE matches Codex's session file naming:
// `rollout-<YYYY>-<MM>-<DD>T<HH>-<MM>-<SS>-<UUID>.jsonl`. The hyphens
// inside the timestamp portion mean we cannot use a generic UUID-suffix
// match — the regex anchors the full filename so we never pick up an
// editor backup, an unrelated .jsonl, or a partially-renamed temp file.
var codexFileRE = regexp.MustCompile(
	`^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-` +
		`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$`,
)

// Walk discovers Codex session JSONL files under root. The layout is
// `<root>/<YYYY>/<MM>/<DD>/rollout-*.jsonl`. We accept the regex match
// at any depth so reorganized archives still work.
//
// A missing root returns an empty slice with no error — typical for
// machines that never installed Codex.
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
			return nil
		}
		if !codexFileRE.MatchString(d.Name()) {
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
