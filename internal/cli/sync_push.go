package cli

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/cli/rpc"
	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/session"
)

// pusher is the per-run uploader. Construct via loadPusher; nil return
// means no auth.json — push silently no-ops (sync stays local-only).
type pusher struct {
	client prosav1connect.SessionsServiceClient
	store  *store.Store
}

// loadPusher reads ~/.config/prosa/auth.json and returns a Sessions
// client + the local store ref. Returns (nil, nil) when no auth file
// exists (the common case for first-run / server-less sync).
func loadPusher(s *store.Store) (*pusher, error) {
	a, err := rpc.LoadAuth()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return &pusher{
		client: rpc.Sessions(a.Server, a.Token),
		store:  s,
	}, nil
}

// pushOutcome describes one push attempt. Used to route counts in
// syncCounts (counts.pushImp / Skip / Err).
type pushOutcome int

const (
	pushSkippedNoAuth pushOutcome = iota
	pushImported
	pushAlreadyHashed
	pushFailed
	pushSkippedNoUsage
)

// pushSession loads sess + turns + tools from the store and POSTs to
// Sessions.Push. Reads raw_path from disk (the importer already
// preserved it). Returns the outcome and the error that drove it (nil
// when the call succeeded, even if the server skipped).
func (p *pusher) pushSession(ctx context.Context, sessionID string) (pushOutcome, error) {
	if p == nil {
		return pushSkippedNoAuth, nil
	}
	sess, err := p.store.GetSession(ctx, sessionID)
	if err != nil {
		return pushFailed, fmt.Errorf("load session: %w", err)
	}
	if !session.HasTokenUsage(sess.Usage) {
		return pushSkippedNoUsage, nil
	}
	turns, err := p.store.GetTurns(ctx, sessionID)
	if err != nil {
		return pushFailed, fmt.Errorf("load turns: %w", err)
	}
	tools, err := p.store.GetSessionTools(ctx, sessionID)
	if err != nil {
		return pushFailed, fmt.Errorf("load tools: %w", err)
	}
	raw, err := os.ReadFile(sess.RawPath)
	if err != nil {
		return pushFailed, fmt.Errorf("read raw %s: %w", sess.RawPath, err)
	}

	req := &prosav1.PushRequest{
		Session: sessionToProto(sess),
		Turns:   turnsToProto(turns),
		Tools:   toolsToProto(tools),
		Raw:     raw,
	}
	resp, err := p.client.Push(ctx, connect.NewRequest(req))
	if err != nil {
		return pushFailed, fmt.Errorf("push rpc: %s", rpc.ConnectError(err))
	}
	if resp.Msg.Skipped {
		return pushAlreadyHashed, nil
	}
	return pushImported, nil
}

func sessionToProto(s session.Session) *prosav1.Session {
	out := &prosav1.Session{
		Id:             s.ID,
		Agent:          s.Agent,
		DeviceId:       s.DeviceID,
		StartedAt:      timestamppb.New(s.StartedAt),
		LastActivityAt: timestamppb.New(s.LastActivityAt),
		RawHash:        s.RawHash,
		RawSize:        s.RawSize,
	}
	if s.ProjectPath != nil {
		out.ProjectPath = wireText(*s.ProjectPath)
	}
	if s.ProjectRemote != nil {
		out.ProjectRemote = wireText(*s.ProjectRemote)
	}
	if s.ProjectMarker != nil {
		out.ProjectMarker = wireText(*s.ProjectMarker)
	}
	if s.FirstPrompt != nil {
		out.FirstPrompt = wireText(*s.FirstPrompt)
	}
	if s.Model != nil {
		out.Model = wireText(*s.Model)
	}
	if s.Usage != nil {
		out.Usage = &prosav1.TokenUsage{
			TotalTokens:         s.Usage.TotalTokens,
			InputTokens:         s.Usage.InputTokens,
			OutputTokens:        s.Usage.OutputTokens,
			CachedTokens:        s.Usage.CachedTokens,
			CacheReadTokens:     s.Usage.CacheReadTokens,
			CacheCreationTokens: s.Usage.CacheCreationTokens,
		}
	}
	return out
}

func turnsToProto(turns []session.Turn) []*prosav1.Turn {
	out := make([]*prosav1.Turn, 0, len(turns))
	for _, t := range turns {
		kind := t.Kind
		if kind == "" {
			kind = session.KindMessage
		}
		out = append(out, &prosav1.Turn{
			Role:     wireText(t.Role),
			Content:  wireText(t.Content),
			Ts:       timestamppb.New(t.Timestamp),
			Kind:     wireText(kind),
			ToolName: wireText(t.ToolName),
		})
	}
	return out
}

func toolsToProto(tools []session.ToolUsage) []*prosav1.ToolUsage {
	out := make([]*prosav1.ToolUsage, 0, len(tools))
	for _, t := range tools {
		out = append(out, &prosav1.ToolUsage{Name: wireText(t.Name), Count: int32(t.Count)})
	}
	return out
}

func wireText(s string) string {
	return strings.ReplaceAll(s, "\x00", " ")
}

// logPush is a thin slog wrapper used by the plain path.
func logPush(sessionID string, outcome pushOutcome, err error) {
	switch outcome {
	case pushImported:
		slog.Info("pushed", "session", sessionID, "status", "done")
	case pushAlreadyHashed:
		slog.Info("pushed", "session", sessionID, "status", "skipped")
	case pushSkippedNoUsage:
		slog.Info("pushed", "session", sessionID, "status", "skipped", "reason", "no_usage")
	case pushFailed:
		slog.Warn("push failed", "session", sessionID, "err", err)
	}
}
