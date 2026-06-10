package importerutil

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestHashAndSize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "raw.jsonl")
	body := []byte("hello\n")
	require.NoError(t, os.WriteFile(path, body, 0o644))

	hash, size, err := HashAndSize(path)
	require.NoError(t, err)

	sum := sha256.Sum256(body)
	require.Equal(t, hex.EncodeToString(sum[:]), hash)
	require.Equal(t, int64(len(body)), size)
}

func TestPreserveRaw(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	src := filepath.Join(t.TempDir(), "source.jsonl")
	require.NoError(t, os.WriteFile(src, []byte("raw\n"), 0o644))

	startedAt := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	dst, err := PreserveRaw("test-agent", "session-1", ".jsonl", startedAt, src)
	require.NoError(t, err)

	require.Equal(t, filepath.Join(os.Getenv("XDG_DATA_HOME"), "prosa", "raw", "test-agent", "2026", "05", "session-1.jsonl"), dst)
	got, err := os.ReadFile(dst)
	require.NoError(t, err)
	require.Equal(t, "raw\n", string(got))
}

func TestPreserveRawRejectsUnsafeSessionID(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	src := filepath.Join(t.TempDir(), "source.jsonl")
	require.NoError(t, os.WriteFile(src, []byte("raw\n"), 0o644))

	_, err := PreserveRaw("test-agent", "../escape", ".jsonl", time.Now(), src)
	require.Error(t, err)
}

func TestPreserveProjectedJSONL(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())

	startedAt := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	lines := []json.RawMessage{
		json.RawMessage(`{"role":"user","content":"hi"}`),
		json.RawMessage(`{"role":"assistant","content":"hello"}`),
	}
	dst, hash, size, err := PreserveProjectedJSONL("test-agent", "session-1", startedAt, lines)
	require.NoError(t, err)
	require.Equal(
		t,
		filepath.Join(os.Getenv("XDG_DATA_HOME"), "prosa", "raw", "test-agent", "2026", "05", "session-1.jsonl"),
		dst,
	)

	got, err := os.ReadFile(dst)
	require.NoError(t, err)
	want := `{"role":"user","content":"hi"}` + "\n" + `{"role":"assistant","content":"hello"}`
	require.Equal(t, want, string(got))

	sum := sha256.Sum256(got)
	require.Equal(t, hex.EncodeToString(sum[:]), hash)
	require.Equal(t, int64(len(got)), size)
}

func TestPreserveProjectedJSONLEmpty(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())

	dst, hash, size, err := PreserveProjectedJSONL("test-agent", "empty-session", time.Now(), nil)
	require.NoError(t, err)
	require.FileExists(t, dst)
	require.Equal(t, int64(0), size)

	sum := sha256.Sum256(nil)
	require.Equal(t, hex.EncodeToString(sum[:]), hash)
}

func TestPreserveProjectedJSONLRejectsUnsafeSessionID(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())

	_, _, _, err := PreserveProjectedJSONL("test-agent", "../escape", time.Now(), nil)
	require.Error(t, err)
}
