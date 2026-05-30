package hermes

import (
	"context"
	"os"
	"path/filepath"
	"strings"
)

// Walk yields every Hermes session source under root. The Hermes layout is:
//
//	<hermes-home>/state.db
//	<hermes-home>/sessions/<id>.jsonl
//	<hermes-home>/sessions/session_<id>.json
//	<hermes-home>/sessions/sessions.json    (index — skipped)
//	<hermes-home>/sessions/saved/...        (archive — skipped)
//
// The CLI configures root as <hermes-home>/sessions. We walk only the top
// level of that directory (no recursion into saved/) and also yield the
// sibling state.db at <root>/../state.db when it exists.
//
// A missing root returns an empty slice with no error.
func (i *Importer) Walk(ctx context.Context, root string) ([]string, error) {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var out []string

	// The sibling state.db sits one directory up from the sessions/ root.
	stateDB := filepath.Join(filepath.Dir(root), "state.db")
	if info, err := os.Stat(stateDB); err == nil && !info.IsDir() {
		out = append(out, stateDB)
	}

	for _, e := range entries {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if name == "sessions.json" {
			continue
		}
		switch {
		case strings.HasSuffix(name, ".jsonl"):
			out = append(out, filepath.Join(root, name))
		case strings.HasPrefix(name, "session_") && strings.HasSuffix(name, ".json"):
			out = append(out, filepath.Join(root, name))
		}
	}
	return out, nil
}
