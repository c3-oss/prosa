package panel

import (
	"bytes"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

func TestIsBinaryChunkDetectsSQLiteMagic(t *testing.T) {
	// SQLite databases (Cursor's store.db) begin with this 16-byte
	// magic. The Cursor importer preserves the file verbatim, so the
	// panel sees the magic at offset 0.
	in := []byte("SQLite format 3\x00")
	in = append(in, bytes.Repeat([]byte{0x00}, 64)...)
	require.True(t, isBinaryChunk(in))
}

func TestIsBinaryChunkDetectsNULByteAnywhereInSniffWindow(t *testing.T) {
	in := append([]byte("perfectly readable header until -> "), 0x00)
	in = append(in, []byte("then more text")...)
	require.True(t, isBinaryChunk(in))
}

func TestIsBinaryChunkDetectsInvalidUTF8(t *testing.T) {
	// 0xC3 0x28 is an incomplete 2-byte UTF-8 sequence — invalid.
	in := []byte{0xC3, 0x28, 'h', 'i'}
	require.True(t, isBinaryChunk(in))
}

func TestIsBinaryChunkAcceptsASCII(t *testing.T) {
	in := []byte(`{"type":"user","content":"refactor sync"}`)
	require.False(t, isBinaryChunk(in))
}

func TestIsBinaryChunkAcceptsMultibyteUTF8(t *testing.T) {
	in := []byte("refatorar a lógica de sincronização — agora 🚀")
	require.False(t, isBinaryChunk(in))
}

func TestIsBinaryChunkAcceptsUTF8RuneCrossingSniffBoundary(t *testing.T) {
	in := bytes.Repeat([]byte("a"), 4095)
	in = append(in, []byte("é stays text")...)
	require.False(t, isBinaryChunk(in))
}

func TestIsBinaryChunkAcceptsEmpty(t *testing.T) {
	require.False(t, isBinaryChunk(nil))
	require.False(t, isBinaryChunk([]byte{}))
}

func TestIsBinaryChunkOnlyLooksAtFirstSniffN(t *testing.T) {
	// A NUL beyond the 4096-byte sniff window must NOT trip the
	// detector (otherwise text-y chunks pulled across NUL-bearing
	// payloads later in the file would be falsely flagged).
	in := bytes.Repeat([]byte("a"), 4096)
	in = append(in, 0x00)
	require.False(t, isBinaryChunk(in))
}

func TestBinaryPlaceholderMentionsSize(t *testing.T) {
	out := binaryPlaceholder(123456)
	require.Contains(t, out, "123456")
	require.True(t, strings.Contains(out, "Binary"),
		"placeholder should label the content as binary")
}

// TestLoadViewsParsesAllTemplates catches template parse errors at
// build time instead of at the first GET that lands on a broken view.
// Failing here means a {{...}} block is unbalanced, a referenced
// template name is missing, or a field accessor uses bad syntax.
func TestLoadViewsParsesAllTemplates(t *testing.T) {
	views, err := loadViews()
	require.NoError(t, err)
	for _, name := range []string{"home", "devices", "analytics", "login", "side_panel", "raw_chunk"} {
		require.Contains(t, views, name, "view %q should be parsed", name)
	}
}

func TestCleanTurnsForDisplayCopiesAndSanitizes(t *testing.T) {
	original := []*prosav1.Turn{
		{Role: "user", Content: "hello \x1b[1mworld\x1b[22m"},
		{Role: "assistant", Content: "ok\x00 trailing"},
		nil,
	}
	got := cleanTurnsForDisplay(original)
	require.Len(t, got, 3)
	require.Equal(t, "hello world", got[0].Content)
	require.Equal(t, "ok trailing", got[1].Content)
	require.Nil(t, got[2])

	// Defensive copy: the originals are untouched so concurrent
	// requests sharing the connect response don't race on Content.
	require.Equal(t, "hello \x1b[1mworld\x1b[22m", original[0].Content)
	require.Equal(t, "ok\x00 trailing", original[1].Content)
}

func TestCleanTurnsForDisplayEmpty(t *testing.T) {
	require.Empty(t, cleanTurnsForDisplay(nil))
	require.Empty(t, cleanTurnsForDisplay([]*prosav1.Turn{}))
}
