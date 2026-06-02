package antigravity

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protowire"
)

func TestParseFieldsEmpty(t *testing.T) {
	fields, err := parseFields(nil)
	require.NoError(t, err)
	require.Nil(t, fields)
}

func TestParseFieldsVarintAndBytes(t *testing.T) {
	var buf []byte
	buf = protowire.AppendTag(buf, 1, protowire.VarintType)
	buf = protowire.AppendVarint(buf, 42)
	buf = protowire.AppendTag(buf, 3, protowire.BytesType)
	buf = protowire.AppendBytes(buf, []byte("hello"))

	fields, err := parseFields(buf)
	require.NoError(t, err)
	require.Len(t, fields, 2)

	require.Equal(t, protowire.Number(1), fields[0].Num)
	require.Equal(t, protowire.VarintType, fields[0].Wire)
	require.Equal(t, uint64(42), fields[0].V)

	require.Equal(t, protowire.Number(3), fields[1].Num)
	require.Equal(t, protowire.BytesType, fields[1].Wire)
	require.Equal(t, []byte("hello"), fields[1].B)
}

func TestFindField(t *testing.T) {
	fields := []Field{
		{Num: 1, Wire: protowire.VarintType, V: 7},
		{Num: 3, Wire: protowire.BytesType, B: []byte("x")},
	}
	f, ok := findField(fields, 3)
	require.True(t, ok)
	require.Equal(t, []byte("x"), f.B)

	_, ok = findField(fields, 99)
	require.False(t, ok)
}

func TestReadTimestampGoogleShape(t *testing.T) {
	// Reproduces the antigravity step-0 timestamp observed on the
	// user's real .db: seconds=1780421834, nanos=214557952. Decodes
	// to 2026-06-02 17:37:14.214557952 UTC.
	var inner []byte
	inner = protowire.AppendTag(inner, 1, protowire.VarintType)
	inner = protowire.AppendVarint(inner, 1780421834)
	inner = protowire.AppendTag(inner, 2, protowire.VarintType)
	inner = protowire.AppendVarint(inner, 214557952)

	got, ok := readTimestamp(inner)
	require.True(t, ok)
	want := time.Date(2026, time.June, 2, 17, 37, 14, 214557952, time.UTC)
	require.True(t, got.Equal(want), "got %v want %v", got, want)
}

func TestReadTimestampNoSecondsFails(t *testing.T) {
	var inner []byte
	inner = protowire.AppendTag(inner, 2, protowire.VarintType)
	inner = protowire.AppendVarint(inner, 12345)
	_, ok := readTimestamp(inner)
	require.False(t, ok)
}

func TestReadStepEventTimeFromMetadata(t *testing.T) {
	var ts []byte
	ts = protowire.AppendTag(ts, 1, protowire.VarintType)
	ts = protowire.AppendVarint(ts, 1780421834)

	var meta []byte
	meta = protowire.AppendTag(meta, 1, protowire.BytesType)
	meta = protowire.AppendBytes(meta, ts)

	got, ok := readStepEventTime(meta)
	require.True(t, ok)
	require.Equal(t, int64(1780421834), got.Unix())
}

func TestReadStepUserPromptStep0(t *testing.T) {
	var inner []byte
	inner = protowire.AppendTag(inner, 2, protowire.BytesType)
	inner = protowire.AppendBytes(inner, []byte("olá"))

	var payload []byte
	payload = protowire.AppendTag(payload, 19, protowire.BytesType)
	payload = protowire.AppendBytes(payload, inner)

	got, ok := readStepUserPrompt(payload)
	require.True(t, ok)
	require.Equal(t, "olá", got)
}

func TestScanStringsRecursive(t *testing.T) {
	var inner []byte
	inner = protowire.AppendTag(inner, 2, protowire.BytesType)
	inner = protowire.AppendBytes(inner, []byte("hello"))

	var outer []byte
	outer = protowire.AppendTag(outer, 1, protowire.BytesType)
	outer = protowire.AppendBytes(outer, inner)
	outer = protowire.AppendTag(outer, 3, protowire.BytesType)
	outer = protowire.AppendBytes(outer, []byte("world"))

	var got []string
	scanStrings(outer, func(s string) bool {
		got = append(got, s)
		return true
	})
	require.Equal(t, []string{"hello", "world"}, got)
}

func TestScanToolCallPair(t *testing.T) {
	var inner []byte
	inner = protowire.AppendTag(inner, 1, protowire.BytesType)
	inner = protowire.AppendBytes(inner, []byte("view_file"))
	inner = protowire.AppendTag(inner, 2, protowire.BytesType)
	inner = protowire.AppendBytes(inner, []byte(`{"AbsolutePath":"/x","toolAction":"y"}`))

	var outer []byte
	outer = protowire.AppendTag(outer, 7, protowire.BytesType)
	outer = protowire.AppendBytes(outer, inner)

	name, args, ok := scanToolCall(outer)
	require.True(t, ok)
	require.Equal(t, "view_file", name)
	require.Equal(t, `{"AbsolutePath":"/x","toolAction":"y"}`, args)
}

func TestScanToolCallToolAction(t *testing.T) {
	var inner []byte
	inner = protowire.AppendTag(inner, 1, protowire.BytesType)
	inner = protowire.AppendBytes(inner, []byte("list_permissions"))
	inner = protowire.AppendTag(inner, 2, protowire.BytesType)
	inner = protowire.AppendBytes(inner, []byte(`{"toolAction":"Listing active permissions"}`))

	name, args, ok := scanToolCall(inner)
	require.True(t, ok)
	require.Equal(t, "list_permissions", name)
	require.Contains(t, args, "toolAction")
}

func TestScanToolCallNoMatch(t *testing.T) {
	var buf []byte
	buf = protowire.AppendTag(buf, 1, protowire.BytesType)
	buf = protowire.AppendBytes(buf, []byte("hello world"))
	_, _, ok := scanToolCall(buf)
	require.False(t, ok)
}

func TestFirstLargeStringSkipsToolJSON(t *testing.T) {
	var buf []byte
	buf = protowire.AppendTag(buf, 1, protowire.BytesType)
	buf = protowire.AppendBytes(buf, []byte(`{"toolAction":"x"}`))
	buf = protowire.AppendTag(buf, 2, protowire.BytesType)
	buf = protowire.AppendBytes(buf, []byte("this is a longer narrative span"))

	got, ok := firstLargeString(buf, 16)
	require.True(t, ok)
	require.Equal(t, "this is a longer narrative span", got)
}

func TestLooksLikeBareword(t *testing.T) {
	for _, s := range []string{"view_file", "run_command", "list-permissions", "codebase_investigator"} {
		require.True(t, looksLikeBareword(s), "want bareword: %q", s)
	}
	for _, s := range []string{"", "12345", "/path/with/slash", "has spaces", "olá"} {
		require.False(t, looksLikeBareword(s), "want NOT bareword: %q", s)
	}
}

func TestIsPrintableUTF8(t *testing.T) {
	require.True(t, isPrintableUTF8([]byte("hello world")))
	require.True(t, isPrintableUTF8([]byte("olá\ntab\there")))
	require.False(t, isPrintableUTF8([]byte{}))
	require.False(t, isPrintableUTF8([]byte{0x00, 0x01, 0x02}))
	require.False(t, isPrintableUTF8([]byte{0xff, 0xfe}))
}
