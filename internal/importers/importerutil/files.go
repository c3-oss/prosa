package importerutil

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite" // sqlite driver registered as "sqlite"

	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/pkg/session"
)

const (
	ScanBufferMax       = 16 << 20
	ScanBufferInitial   = 64 << 10
	FirstPromptMaxRunes = 200
	ToolPreviewMaxBytes = 4096
	ToolPreviewMaxLines = 40
)

func HashAndSize(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = f.Close() }()

	h := sha256.New()
	size, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), size, nil
}

func PreserveRaw(agent, sessionID, ext string, startedAt time.Time, srcPath string) (string, error) {
	if err := session.ValidateID(sessionID); err != nil {
		return "", fmt.Errorf("preserve raw: %w", err)
	}
	root, err := paths.RawRoot(agent)
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

func OpenSQLiteReadOnly(path string) (*sql.DB, error) {
	dsn := "file:" + url.PathEscape(path) + "?mode=ro&immutable=1"
	return sql.Open("sqlite", dsn)
}

// PreserveProjectedJSONL writes already-serialized JSONL lines (one
// json.RawMessage per line) to raw/<agent>/<YYYY>/<MM>/<sessionID>.jsonl
// atomically, returning the final path, sha256, and byte size. Lines are
// joined with '\n' and the file ends without a trailing newline — the
// same on-disk shape Hermes' per-session `<id>.jsonl` flavor already
// uses, so consumers can't tell whether the raw came from a transcript
// or from a state.db projection.
//
// Same path layout, atomicity (`.tmp` + rename), and session-id
// validation as PreserveRaw; the difference is the content comes from
// memory and the sha256 is computed alongside the write via
// io.MultiWriter rather than re-reading the file afterwards.
func PreserveProjectedJSONL(agent, sessionID string, startedAt time.Time, lines []json.RawMessage) (string, string, int64, error) {
	if err := session.ValidateID(sessionID); err != nil {
		return "", "", 0, fmt.Errorf("preserve projected jsonl: %w", err)
	}
	root, err := paths.RawRoot(agent)
	if err != nil {
		return "", "", 0, err
	}
	if startedAt.IsZero() {
		startedAt = time.Now()
	}
	year := fmt.Sprintf("%04d", startedAt.UTC().Year())
	month := fmt.Sprintf("%02d", startedAt.UTC().Month())
	dir := filepath.Join(root, year, month)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", 0, fmt.Errorf("mkdir %s: %w", dir, err)
	}

	dst := filepath.Join(dir, sessionID+".jsonl")
	tmp := dst + ".tmp"

	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return "", "", 0, err
	}
	hasher := sha256.New()
	w := io.MultiWriter(out, hasher)

	var size int64
	for i, line := range lines {
		if i > 0 {
			n, err := w.Write([]byte{'\n'})
			if err != nil {
				_ = out.Close()
				_ = os.Remove(tmp)
				return "", "", 0, fmt.Errorf("write projected jsonl separator: %w", err)
			}
			size += int64(n)
		}
		n, err := w.Write(line)
		if err != nil {
			_ = out.Close()
			_ = os.Remove(tmp)
			return "", "", 0, fmt.Errorf("write projected jsonl line %d: %w", i, err)
		}
		size += int64(n)
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return "", "", 0, err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return "", "", 0, fmt.Errorf("rename projected jsonl: %w", err)
	}
	return dst, hex.EncodeToString(hasher.Sum(nil)), size, nil
}
