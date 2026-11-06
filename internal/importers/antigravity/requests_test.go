package antigravity

import (
	"context"
	"database/sql"
	"net/url"
	"testing"

	"github.com/c3-oss/prosa/pkg/session"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protowire"
)

func TestStepUsageRetainsRequestIdentityAndModelEnum(t *testing.T) {
	var stats []byte
	stats = protowire.AppendTag(stats, 1, protowire.VarintType)
	stats = protowire.AppendVarint(stats, 1020)
	stats = protowire.AppendTag(stats, 2, protowire.VarintType)
	stats = protowire.AppendVarint(stats, 100)
	stats = protowire.AppendTag(stats, 11, protowire.BytesType)
	stats = protowire.AppendString(stats, "request-a")
	var metadata []byte
	metadata = protowire.AppendTag(metadata, 9, protowire.BytesType)
	metadata = protowire.AppendBytes(metadata, stats)
	usage := readStepUsage(metadata)
	require.True(t, usage.Present)
	require.Equal(t, uint64(1020), usage.ModelID)
	require.Equal(t, "request-a", usage.RequestID)
	require.Equal(t, int64(100), usage.InputTokens)
}

func TestRequestsPreserveStepModelsAndDeduplicate(t *testing.T) {
	path := makeAntigravityFixture(t, t.TempDir(), 1780421834)
	db, err := sql.Open("sqlite", "file:"+url.PathEscape(path)+"?mode=rw")
	require.NoError(t, err)
	_, err = db.Exec(`CREATE TABLE executor_metadata (idx integer, data blob)`)
	require.NoError(t, err)
	for i, model := range []string{"gemini-3.5-flash-low", "gemini-3.8-flash"} {
		var name []byte
		name = protowire.AppendTag(name, 28, protowire.BytesType)
		name = protowire.AppendString(name, model)
		var variant []byte
		variant = protowire.AppendTag(variant, 1, protowire.BytesType)
		variant = protowire.AppendBytes(variant, name)
		var exec []byte
		exec = protowire.AppendTag(exec, 10, protowire.BytesType)
		exec = protowire.AppendBytes(exec, variant)
		_, err = db.Exec(`INSERT INTO executor_metadata(idx,data) VALUES (?,?)`, i+1, exec)
		require.NoError(t, err)
	}
	var stats []byte
	stats = protowire.AppendTag(stats, 2, protowire.VarintType)
	stats = protowire.AppendVarint(stats, 100)
	stats = protowire.AppendTag(stats, 3, protowire.VarintType)
	stats = protowire.AppendVarint(stats, 20)
	stats = protowire.AppendTag(stats, 11, protowire.BytesType)
	stats = protowire.AppendString(stats, "request-a")
	metadata := buildTimestampMeta(1780421835)
	metadata = protowire.AppendTag(metadata, 9, protowire.BytesType)
	metadata = protowire.AppendBytes(metadata, stats)
	_, err = db.Exec(`UPDATE steps SET metadata=? WHERE idx IN (1,2)`, metadata)
	require.NoError(t, err)
	require.NoError(t, db.Close())
	sess, _, _, _, err := parseSession(context.Background(), path)
	require.NoError(t, err)
	require.Len(t, sess.Requests, 1)
	require.Equal(t, session.RequestCoverageComplete, sess.RequestCoverage)
	require.Equal(t, "request-a", sess.Requests[0].ID)
	require.Equal(t, "gemini-3.5-flash-low", sess.Requests[0].Model)
	require.Equal(t, int64(120), sess.Usage.TotalTokens)
	require.Equal(t, int64(1780421835), sess.Requests[0].Timestamp.Unix())
}
