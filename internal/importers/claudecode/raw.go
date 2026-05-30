package claudecode

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/c3-oss/prosa/internal/paths"
)

// preserveRaw copies the source JSONL into the prosa raw tree at:
//
//	$PROSA_HOME/raw/claude-code/<YYYY>/<MM>/<session-id>.jsonl
//
// using write-to-tmp + rename for atomicity. The source is never modified
// or removed — Claude Code may still be appending to it.
//
// When startedAt is zero, the current time is used; this keeps month
// sharding monotonic even when an importer is fed a malformed file.
func preserveRaw(srcPath, sessionID string, startedAt time.Time) (string, error) {
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

	dst := filepath.Join(dir, sessionID+".jsonl")
	tmp := dst + ".tmp"

	src, err := os.Open(srcPath)
	if err != nil {
		return "", err
	}
	defer src.Close()

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
