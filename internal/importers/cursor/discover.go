package cursor

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
)

// Walk yields every Cursor store.db under root. Layout per
// legacy-v2:docs/sources/cursor.md:
//
//	<root>/<workspace-id>/<agent-id>/store.db
//
// The workspace/agent ids are opaque hex strings; we don't reverse them
// into project paths in cut 3. WAL/SHM siblings are silently ignored —
// SQLite reads the canonical store.db with its own recovery path.
//
// A missing root returns an empty slice with no error.
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
		if d.Name() != "store.db" {
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
