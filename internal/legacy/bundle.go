// Package legacy reads the prosa v1 ".prosa" data bundle (a SQLite
// catalog + content-addressed zstd-compressed raw source files) so the
// v3 importers can re-ingest historical sessions whose original source
// files have since disappeared from the filesystem (e.g., Claude Code
// retention deleted ~/.claude/projects/.../*.jsonl past a few weeks).
//
// See docs/sources/legacy-bundle.md for the on-disk layout, and
// internal/cli/sync.go for the `prosa sync --legacy-bundle` wiring that
// drives this package end-to-end.
package legacy

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/klauspost/compress/zstd"

	_ "modernc.org/sqlite" // sqlite driver registered as "sqlite"
)

// Bundle wraps a read-only handle to a v1 prosa bundle directory. The
// caller MUST Close it when done.
type Bundle struct {
	Path string
	db   *sql.DB
}

// SourceFile is one row from the v1 `source_files` table, scoped to the
// fields the v3 re-ingestion pipeline actually consumes.
type SourceFile struct {
	// Tool is the v1 source_tool string: "claude" | "codex" | "cursor" |
	// "gemini". sync.go maps this to a v3 importer instance.
	Tool string

	// OriginalPath is where the source file used to live on disk (e.g.
	// /Users/u/.claude/projects/.../<uuid>.jsonl). Used as the basename
	// for the decompressed temp file so downstream parsers' filename
	// fallback works.
	OriginalPath string

	// ObjectIDHex is the content hash without the "blake3:" prefix —
	// matches the filename in <bundle>/raw/sources/<hex>.zst.
	ObjectIDHex string

	// SizeBytes is the uncompressed source file size at v1 import time.
	SizeBytes int64
}

// Open validates that path looks like a v1 bundle (has prosa.sqlite
// alongside raw/sources/) and opens the SQLite catalog read-only.
func Open(path string) (*Bundle, error) {
	dbPath := filepath.Join(path, "prosa.sqlite")
	if _, err := os.Stat(dbPath); err != nil {
		return nil, fmt.Errorf("legacy bundle missing prosa.sqlite at %s: %w", dbPath, err)
	}
	rawDir := filepath.Join(path, "raw", "sources")
	if _, err := os.Stat(rawDir); err != nil {
		return nil, fmt.Errorf("legacy bundle missing raw/sources at %s: %w", rawDir, err)
	}
	dsn := "file:" + url.PathEscape(dbPath) + "?mode=ro&immutable=1"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open legacy sqlite: %w", err)
	}
	return &Bundle{Path: path, db: db}, nil
}

func (b *Bundle) Close() error {
	if b == nil || b.db == nil {
		return nil
	}
	return b.db.Close()
}

// SourceFiles returns the catalog rows the v3 pipeline can re-ingest.
// Only the tools v3 has importers for are returned; v1 also stored
// `hermes`, which had zero rows in practice and stays excluded.
func (b *Bundle) SourceFiles(ctx context.Context) ([]SourceFile, error) {
	const q = `
		SELECT source_tool, path, substr(object_id, 8) AS oid_hex, size_bytes
		FROM source_files
		WHERE source_tool IN ('claude','codex','cursor','gemini')
		  AND object_id LIKE 'blake3:%'
		ORDER BY source_tool, path
	`
	rows, err := b.db.QueryContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("query source_files: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []SourceFile
	for rows.Next() {
		var s SourceFile
		if err := rows.Scan(&s.Tool, &s.OriginalPath, &s.ObjectIDHex, &s.SizeBytes); err != nil {
			return nil, fmt.Errorf("scan source_files row: %w", err)
		}
		if s.ObjectIDHex == "" {
			continue
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// Decompress reads <bundle>/raw/sources/<ObjectIDHex>.zst, writes the
// uncompressed bytes to <tmpDir>/<basename(OriginalPath)>, and returns
// the temp path. Preserving the source basename matters for codex (the
// importer falls back to the filename UUID when session_meta is absent)
// and for cursor (where the temp file is opened as a SQLite db).
//
// Respects ctx.Done() before opening the source file. The decompress
// itself is not cancellable mid-stream — zstd reads can take seconds on
// large files — but that's bounded by per-file size in practice.
func (b *Bundle) Decompress(ctx context.Context, sf SourceFile, tmpDir string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	src := filepath.Join(b.Path, "raw", "sources", sf.ObjectIDHex+".zst")
	in, err := os.Open(src)
	if err != nil {
		return "", fmt.Errorf("open zst %s: %w", src, err)
	}
	defer func() { _ = in.Close() }()

	dec, err := zstd.NewReader(in)
	if err != nil {
		return "", fmt.Errorf("zstd reader: %w", err)
	}
	defer dec.Close()

	base := filepath.Base(sf.OriginalPath)
	if base == "" || base == "." || base == string(os.PathSeparator) {
		base = sf.ObjectIDHex + extFor(sf.Tool)
	}
	// Ensure ObjectIDHex prefix to avoid two stores ever colliding in
	// the same tmpDir when basenames repeat (e.g. every cursor store
	// is `store.db`).
	dst := filepath.Join(tmpDir, sf.ObjectIDHex[:12]+"-"+base)
	if !strings.HasSuffix(dst, extFor(sf.Tool)) && sf.Tool == "cursor" {
		dst += ".db"
	}

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return "", fmt.Errorf("create temp %s: %w", dst, err)
	}
	if _, err := io.Copy(out, dec); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return "", fmt.Errorf("decompress: %w", err)
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dst)
		return "", fmt.Errorf("close temp: %w", err)
	}
	return dst, nil
}

// extFor returns the canonical extension v3 importers expect on disk for
// the given v1 source_tool. The temp filename uses this to keep things
// recognizable, but the importer flow keys off content and filename
// fallback (not extension).
func extFor(tool string) string {
	switch tool {
	case "claude", "codex":
		return ".jsonl"
	case "gemini":
		return ".json"
	case "cursor":
		return ".db"
	}
	return ""
}
