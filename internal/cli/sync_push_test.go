package cli

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func TestPushProtoSanitizesDerivedText(t *testing.T) {
	projectPath := "/tmp/a\x00b"
	projectRemote := "git@example.com:a\x00b.git"
	projectMarker := "marker\x00name"
	firstPrompt := "hello\x00world"
	model := "model\x00name"
	parentID := "parent-session-id"
	now := time.Now().UTC()

	sess := session.Session{
		ID:              "session\x00id",
		Agent:           "codex",
		DeviceID:        "device\x00id",
		ProjectPath:     &projectPath,
		ProjectRemote:   &projectRemote,
		ProjectMarker:   &projectMarker,
		StartedAt:       now,
		LastActivityAt:  now,
		FirstPrompt:     &firstPrompt,
		Model:           &model,
		RawHash:         "hash\x00value",
		RawSize:         123,
		ParentSessionID: &parentID,
	}
	gotSession := sessionToProto(sess)
	require.Equal(t, "session\x00id", gotSession.Id)
	require.Equal(t, "device\x00id", gotSession.DeviceId)
	require.Equal(t, "hash\x00value", gotSession.RawHash)
	require.Equal(t, "/tmp/a b", gotSession.ProjectPath)
	require.Equal(t, "git@example.com:a b.git", gotSession.ProjectRemote)
	require.Equal(t, "marker name", gotSession.ProjectMarker)
	require.Equal(t, "hello world", gotSession.FirstPrompt)
	require.Equal(t, "model name", gotSession.Model)
	require.Equal(t, "parent-session-id", gotSession.ParentSessionId)

	gotTurns := turnsToProto([]session.Turn{{
		Role:      "tool\x00role",
		Content:   "content\x00body",
		Timestamp: now,
		Kind:      "kind\x00name",
		ToolName:  "tool\x00name",
	}})
	require.Len(t, gotTurns, 1)
	require.Equal(t, "tool role", gotTurns[0].Role)
	require.Equal(t, "content body", gotTurns[0].Content)
	require.Equal(t, "kind name", gotTurns[0].Kind)
	require.Equal(t, "tool name", gotTurns[0].ToolName)

	gotTools := toolsToProto([]session.ToolUsage{{Name: "read\x00file", Count: 2}})
	require.Len(t, gotTools, 1)
	require.Equal(t, "read file", gotTools[0].Name)
	require.Equal(t, int32(2), gotTools[0].Count)
}

func TestShouldChunkPush(t *testing.T) {
	require.False(t, shouldChunkPush(chunkPushThresholdBytes))
	require.True(t, shouldChunkPush(chunkPushThresholdBytes+1))
}
