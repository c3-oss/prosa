package gemini

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Walk yields every Gemini chat history file under root. Two filenames
// qualify:
//
//   - `chats/session-*.json` — legacy bundle / older live layout, one
//     envelope object per file (see docs/sources/legacy-bundle.md).
//   - `logs.json` — newer live layout, an array of standalone records.
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
		name := d.Name()
		if name == "logs.json" {
			empty, err := isEmptyLiveLogs(path)
			if err != nil {
				return err
			}
			if empty {
				return nil
			}
			out = append(out, path)
			return nil
		}
		if strings.HasPrefix(name, "session-") && strings.HasSuffix(name, ".json") {
			out = append(out, path)
			return nil
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func isEmptyLiveLogs(path string) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(data)) == "[]", nil
}
