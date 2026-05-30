package hermes

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/c3-oss/prosa/internal/paths"
)

// preserveRaw copies the source file into the prosa raw tree at:
//
//	$PROSA_HOME/raw/hermes/<YYYY>/<MM>/<session-id><ext>
//
// using write-to-tmp + rename for atomicity. ext is supplied by the
// caller because the same state.db source produces one .db copy per
// session id, while .jsonl / .json sources each map to a single copy.
// The source is never modified or removed.
func preserveRaw(srcPath, sessionID string, startedAt time.Time, ext string) (string, error) {
	root, err := paths.RawRoot(Name)
	if err != nil {
		return "", err
	}
	if startedAt.IsZero() {
		startedAt = time.Now()
	}
	year := fmt.Sprintf("%04d", startedAt.UTC().Year())
	month := fmt.Sprintf("%02d", startedAt.UTC().Month())
	dir := filepath.Join(root, year, month)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("mkdir %s: %w", dir, err)
	}

	dst := filepath.Join(dir, sessionID+ext)
	tmp := dst + ".tmp"

	src, err := os.Open(srcPath)
	if err != nil {
		return "", err
	}
	defer func() { _ = src.Close() }()

	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(out, src); err != nil {
		_ = out.Close()
		_ = os.Remove(tmp)
		return "", fmt.Errorf("copy raw: %w", err)
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("rename raw: %w", err)
	}
	return dst, nil
}
