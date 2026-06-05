package cli

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/cli/rpc"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/session"
)

// pusher is the per-run uploader. Construct via loadPusher; nil return
// means no auth.json — push silently no-ops (sync stays local-only).
type pusher struct {
	client            prosav1connect.SessionsServiceClient
	store             *store.Store
	server            string
	remoteUnavailable bool

	// logger receives the catch-up phase's structured output. The
	// interactive TTY path sets this to a discard logger so reconcile
	// lines don't clobber Bubble Tea repaints, instead of mutating the
	// process-global slog default. nil falls back to slog.Default().
	logger *slog.Logger
}

// log returns the pusher's logger, defaulting to the package default when
// unset (the plain path and tests that build a pusher directly).
func (p *pusher) log() *slog.Logger {
	if p.logger != nil {
		return p.logger
	}
	return slog.Default()
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
	server := rpc.NormalizeServerURL(a.Server)
	return &pusher{
		client: rpc.Sessions(server, a.Token),
		store:  s,
		server: server,
		logger: slog.Default(),
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
	pushSkippedRemoteUnavailable
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
	if p.remoteUnavailable {
		return pushSkippedRemoteUnavailable, nil
	}
	sess, err := p.store.GetSession(ctx, sessionID)
	if err != nil {
		return pushFailed, fmt.Errorf("load session: %w", err)
	}
	// No-usage gating happens at the importer (UsageStateExplicitZero
	// → recorded as a no_usage skip and never inserted into the store).
	// Anything that lives in the store is admissible to push, including
	// cursor and pre-token_count codex sessions that carry no Usage row.
	turns, err := p.store.GetTurns(ctx, sessionID)
	if err != nil {
		return pushFailed, fmt.Errorf("load turns: %w", err)
	}
	tools, err := p.store.GetSessionTools(ctx, sessionID)
	if err != nil {
		return pushFailed, fmt.Errorf("load tools: %w", err)
	}
	rawPath, err := safeRawPathForPush(sess.Agent, sess.RawPath)
	if err != nil {
		return pushFailed, fmt.Errorf("validate raw path for %s: %w", sessionID, err)
	}
	raw, err := os.ReadFile(rawPath)
	if err != nil {
		return pushFailed, fmt.Errorf("read raw %s: %w", rawPath, err)
	}

	req := &prosav1.PushRequest{
		Session: sessionToProto(sess),
		Turns:   turnsToProto(turns),
		Tools:   toolsToProto(tools),
		Raw:     raw,
	}
	resp, err := p.client.Push(ctx, connect.NewRequest(req))
	if err != nil {
		if isRemoteUnavailable(err) {
			p.markRemoteUnavailable()
			return pushSkippedRemoteUnavailable, nil
		}
		return pushFailed, fmt.Errorf("push rpc: %w", err)
	}
	if resp.Msg.Skipped {
		return pushAlreadyHashed, nil
	}
	return pushImported, nil
}

func safeRawPathForPush(agent, rawPath string) (string, error) {
	if strings.TrimSpace(agent) == "" {
		return "", errors.New("session agent is empty")
	}
	if strings.TrimSpace(rawPath) == "" {
		return "", errors.New("session raw_path is empty")
	}

	root, err := paths.RawRoot(agent)
	if err != nil {
		return "", fmt.Errorf("resolve raw root: %w", err)
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve raw root %s: %w", root, err)
	}
	rawPath, err = filepath.EvalSymlinks(rawPath)
	if err != nil {
		return "", fmt.Errorf("resolve raw path %s: %w", rawPath, err)
	}

	root = filepath.Clean(root)
	rawPath = filepath.Clean(rawPath)
	rel, err := filepath.Rel(root, rawPath)
	if err != nil {
		return "", fmt.Errorf("compare raw path %s to root %s: %w", rawPath, root, err)
	}
	if rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("raw path %s resolves outside raw root %s", rawPath, root)
	}
	return rawPath, nil
}

func isRemoteUnavailable(err error) bool {
	return connect.CodeOf(err) == connect.CodeUnavailable
}

func (p *pusher) markRemoteUnavailable() {
	if p == nil || p.remoteUnavailable {
		return
	}
	p.remoteUnavailable = true
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
