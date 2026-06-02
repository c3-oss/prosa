package antigravity

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Walk yields every Antigravity conversation .db under root. Files of
// zero length are skipped — antigravity creates the file lazily on the
// first step, so an empty entry means the user opened agy but never
// produced a step. A missing root returns an empty slice with no error
// (same posture as the other importers).
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
		if !strings.HasSuffix(d.Name(), ".db") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Size() == 0 {
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
