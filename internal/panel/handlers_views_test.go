package panel

import (
	"bytes"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
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
