package legacy

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/klauspost/compress/zstd"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

// buildFixtureBundle stages a synthetic v2 prosa bundle at root:
//
//	<root>/prosa.sqlite
//	<root>/raw/sources/<oid>.zst   (per source_files row)
func buildFixtureBundle(t *testing.T) (string, map[string]string) {
	t.Helper()
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "raw", "sources"), 0o755))

	dbPath := filepath.Join(root, "prosa.sqlite")
	db, err := sql.Open("sqlite", dbPath)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	_, err = db.Exec(`CREATE TABLE source_files (
		source_file_id TEXT, source_tool TEXT, path TEXT,
		object_id TEXT, size_bytes INTEGER
	)`)
	require.NoError(t, err)

	type row struct {
		tool, path, oid string
		body            []byte
	}
	rows := []row{
		{
			tool: "claude",
			path: "/Users/u/.claude/projects/-Users-u-proj/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
			oid:  "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
			body: []byte(`{"type":"user","sessionId":"aaaa-uuid","timestamp":"2026-01-01T00:00:00Z"}` + "\n"),
		},
		{
			tool: "codex",
			path: "/Users/u/.codex/sessions/2025/08/20/rollout-2025-08-20T23-00-00-92161551-92ca-4be9-9474-d670adf16da6.jsonl",
			oid:  "bbbb1111cccc2222dddd3333eeee4444ffff5555aaaa6666bbbb7777cccc8888",
			body: []byte(`{"id":"92161551-92ca-4be9-9474-d670adf16da6","timestamp":"2025-08-20T23:00:00Z"}` + "\n"),
		},
		{
			tool: "cursor",
			path: "/Users/u/.cursor/chats/ws/agent-uuid/store.db",
			oid:  "cccc1111dddd2222eeee3333ffff4444aaaa5555bbbb6666cccc7777dddd8888",
			body: []byte("SQLite format 3\x00... (fake)"),
		},
		{
			tool: "gemini",
			path: "/Users/u/.gemini/tmp/hash/chats/session-2026-01-22T15-40-2dfdf4cf.json",
			oid:  "dddd1111eeee2222ffff3333aaaa4444bbbb5555cccc6666dddd7777eeee8888",
			body: []byte(`{"sessionId":"2dfdf4cf-1ea8-4bea-a5ac-e35b3c0ae0bc","messages":[]}`),
		},
		// Excluded: hermes / unknown / missing blake3 prefix.
		{
			tool: "hermes", path: "/dev/null", oid: "aaaa9999bbbb9999cccc9999dddd9999eeee9999ffff9999aaaa9999bbbb9999",
			body: []byte("ignored"),
		},
	}

	for _, r := range rows {
		_, err := db.Exec(`INSERT INTO source_files VALUES (?, ?, ?, ?, ?)`,
			"sf-"+r.oid, r.tool, r.path, "blake3:"+r.oid, len(r.body))
		require.NoError(t, err)
		// Drop the .zst under raw/sources/.
		compressed := compressBytes(t, r.body)
		require.NoError(t, os.WriteFile(filepath.Join(root, "raw", "sources", r.oid+".zst"), compressed, 0o644))
	}

	// Expected oid → original body, for decompress round-trip.
	expect := map[string]string{
		"aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888": string(rows[0].body),
		"bbbb1111cccc2222dddd3333eeee4444ffff5555aaaa6666bbbb7777cccc8888": string(rows[1].body),
		"cccc1111dddd2222eeee3333ffff4444aaaa5555bbbb6666cccc7777dddd8888": string(rows[2].body),
		"dddd1111eeee2222ffff3333aaaa4444bbbb5555cccc6666dddd7777eeee8888": string(rows[3].body),
	}
	return root, expect
}

func compressBytes(t *testing.T, data []byte) []byte {
	t.Helper()
	enc, err := zstd.NewWriter(nil)
	require.NoError(t, err)
	defer func() { _ = enc.Close() }()
	return enc.EncodeAll(data, nil)
}

func TestOpenAndIterate(t *testing.T) {
	root, expected := buildFixtureBundle(t)

	b, err := Open(root)
	require.NoError(t, err)
	t.Cleanup(func() { _ = b.Close() })

	files, err := b.SourceFiles(context.Background())
	require.NoError(t, err)
	require.Len(t, files, 4) // hermes excluded by query

	gotTools := map[string]bool{}
	for _, sf := range files {
		gotTools[sf.Tool] = true
		require.NotEmpty(t, sf.ObjectIDHex)
		require.Contains(t, expected, sf.ObjectIDHex)
	}
	require.True(t, gotTools["claude"])
	require.True(t, gotTools["codex"])
	require.True(t, gotTools["cursor"])
	require.True(t, gotTools["gemini"])
}

func TestDecompressRoundTrip(t *testing.T) {
	root, expected := buildFixtureBundle(t)
	b, err := Open(root)
	require.NoError(t, err)
	t.Cleanup(func() { _ = b.Close() })

	tmpDir := t.TempDir()
	files, err := b.SourceFiles(context.Background())
	require.NoError(t, err)

	for _, sf := range files {
		dst, err := b.Decompress(sf, tmpDir)
		require.NoError(t, err)
		raw, err := os.ReadFile(dst)
		require.NoError(t, err)
		require.Equal(t, expected[sf.ObjectIDHex], string(raw))
		// Basename must preserve the original suffix so codex's UUID
		// fallback and cursor's .db extension stay intact.
		switch sf.Tool {
		case "claude", "codex":
			require.True(t, filepath.Ext(dst) == ".jsonl")
		case "gemini":
			require.True(t, filepath.Ext(dst) == ".json")
		case "cursor":
			require.True(t, filepath.Ext(dst) == ".db")
		}
	}
}

func TestOpenMissingPaths(t *testing.T) {
	_, err := Open(t.TempDir())
	require.Error(t, err)
}
