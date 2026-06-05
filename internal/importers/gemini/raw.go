package gemini

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/pkg/session"
)

// preserveRaw copies the source JSON into the prosa raw tree at:
//
//	$PROSA_HOME/raw/gemini/<YYYY>/<MM>/<session-id>.json
//
// Atomic write-tmp + rename. The source is never modified or removed.
// When startedAt is zero (the file had no parseable timestamp), the
// current wall clock is used so month sharding stays monotonic.
func preserveRaw(srcPath, sessionID string, startedAt time.Time) (string, error) {
	if err := session.ValidateID(sessionID); err != nil {
		return "", fmt.Errorf("preserve raw: %w", err)
	}
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

	dst := filepath.Join(dir, sessionID+".json")
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
