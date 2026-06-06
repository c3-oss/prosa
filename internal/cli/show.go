package cli

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/cli/rpc"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/session"
)

var (
	showRawFlag        bool
	showRemoteFlag     bool
	showMaxOutputLines int
)

func newShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show <session-id>",
		Short: "Print a session's projected turns or preserved raw transcript",
		Long: "By default, renders the human-readable session view (header + turns) " +
			"to stdout when stdout is a TTY. --raw prints the preserved JSONL bytes " +
			"verbatim. --json prints a single JSON object with `session`, `tools`, " +
			"and `turns`. --remote fetches projected or raw content from the prosa-server.",
		Args: cobra.ExactArgs(1),
		RunE: runShow,
	}
	cmd.Flags().BoolVar(&showRawFlag, "raw", false,
		"emit the preserved raw JSONL bytes verbatim (skips the renderer)")
	cmd.Flags().BoolVar(&showRemoteFlag, "remote", false,
		"fetch the session from the prosa-server instead of the local store")
	cmd.Flags().IntVar(&showMaxOutputLines, "max-output-lines", 0,
		"cap lines per turn body in the rendered/JSON view (0 = no limit)")
	return cmd
}

// showPayload is the single JSON object emitted by `prosa show --json`.
// Field names are camelCase to match what scripts that already consume
// the timeline NDJSON expect after Go's default marshaller is replaced
// with explicit tags.
type showPayload struct {
	Session session.Session     `json:"session"`
	Tools   []session.ToolUsage `json:"tools"`
	Turns   []session.Turn      `json:"turns"`
}

func runShow(cmd *cobra.Command, args []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	if showMaxOutputLines < 0 {
		return fmt.Errorf("--max-output-lines must be >= 0")
	}

	id := args[0]
	mode := selectShowOutputMode(g.JSON, showRawFlag, showRemoteFlag, IsInteractive())
	if mode == showModeRemoteRaw {
		return copyRemoteRaw(ctx, id, os.Stdout)
	}

	var payload showPayload
	var err error
	if showRemoteFlag {
		payload, err = loadShowRemote(ctx, id)
	} else {
		payload, err = loadShowLocal(ctx, id)
	}
	if err != nil {
		return err
	}

	switch mode {
	case showModeJSON:
		payload = capShowPayloadLines(payload, showMaxOutputLines)
		return emitShowJSON(os.Stdout, payload)
	case showModeLocalRaw:
		return copyRaw(payload.Session.RawPath)
	case showModeRendered:
		return render.ShowSession(os.Stdout, render.SessionDetail{
			Session:        payload.Session,
			Tools:          payload.Tools,
			Turns:          payload.Turns,
			Width:          TerminalWidth(),
			MaxOutputLines: showMaxOutputLines,
		})
	default:
		// Non-TTY, no --json, no --raw: stay pipeable by emitting the
		// local raw bytes — `prosa show <id> | jq` historic behavior.
		return copyRaw(payload.Session.RawPath)
	}
}

type showOutputMode int

const (
	showModeJSON showOutputMode = iota
	showModeRemoteRaw
	showModeLocalRaw
	showModeRendered
	showModeLocalPipeRaw
)

func selectShowOutputMode(jsonMode, raw, remote, interactive bool) showOutputMode {
	switch {
	case jsonMode:
		return showModeJSON
	case remote && (raw || !interactive):
		return showModeRemoteRaw
	case raw:
		return showModeLocalRaw
	case interactive:
		return showModeRendered
	default:
		return showModeLocalPipeRaw
	}
}

func loadShowLocal(ctx context.Context, id string) (showPayload, error) {
	storePath, err := paths.StorePath()
	if err != nil {
		return showPayload{}, err
	}
	s, err := store.OpenReadOnly(ctx, storePath)
	if err != nil {
		return showPayload{}, err
	}
	defer func() { _ = s.Close() }()

	sess, err := s.GetSession(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return showPayload{}, fmt.Errorf("session %s not found", id)
		}
		return showPayload{}, err
	}
	turns, err := s.GetTurns(ctx, id)
	if err != nil {
		return showPayload{}, err
	}
	tools, err := s.GetSessionTools(ctx, id)
	if err != nil {
		return showPayload{}, err
	}
	return showPayload{Session: sess, Tools: tools, Turns: turns}, nil
}

func loadShowRemote(ctx context.Context, id string) (showPayload, error) {
	auth, err := rpc.LoadAuth()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return showPayload{}, errors.New("not logged in — run `prosa login --server <URL>` first")
		}
		return showPayload{}, err
	}
	client := rpc.Sessions(auth.Server, auth.Token)
	resp, err := client.Get(ctx, connect.NewRequest(&prosav1.GetRequest{Id: id}))
	if err != nil {
		return showPayload{}, fmt.Errorf("show rpc: %s", rpc.ConnectError(err))
	}
	return showPayload{
		Session: remoteSessionToLocal(resp.Msg.Session),
		Tools:   remoteToolsToLocal(resp.Msg.Tools),
		Turns:   remoteTurnsToLocal(resp.Msg.Turns),
	}, nil
}

func emitShowJSON(w io.Writer, p showPayload) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(p)
}

func capShowPayloadLines(p showPayload, max int) showPayload {
	if max <= 0 {
		return p
	}
	p.Turns = append([]session.Turn(nil), p.Turns...)
	for i := range p.Turns {
		p.Turns[i].Content = capLines(p.Turns[i].Content, max)
	}
	return p
}

func capLines(content string, max int) string {
	if max <= 0 {
		return content
	}
	lines := strings.Split(content, "\n")
	if len(lines) <= max {
		return content
	}
	out := make([]string, 0, max+1)
	out = append(out, lines[:max]...)
	out = append(out, "…")
	return strings.Join(out, "\n")
}

func remoteSessionToLocal(in *prosav1.Session) session.Session {
	if in == nil {
		return session.Session{}
	}
	out := session.Session{
		ID:             in.Id,
		Agent:          in.Agent,
		DeviceID:       in.DeviceId,
		StartedAt:      in.StartedAt.AsTime(),
		LastActivityAt: in.LastActivityAt.AsTime(),
		RawPath:        in.RawUri,
		RawHash:        in.RawHash,
		RawSize:        in.RawSize,
	}
	if in.ProjectPath != "" {
		v := in.ProjectPath
		out.ProjectPath = &v
	}
	if in.ProjectRemote != "" {
		v := in.ProjectRemote
		out.ProjectRemote = &v
	}
	if in.ProjectMarker != "" {
		v := in.ProjectMarker
		out.ProjectMarker = &v
	}
	if in.FirstPrompt != "" {
		v := in.FirstPrompt
		out.FirstPrompt = &v
	}
	if in.Model != "" {
		v := in.Model
		out.Model = &v
	}
	if in.Usage != nil {
		out.Usage = &session.TokenUsage{
			TotalTokens:         in.Usage.TotalTokens,
			InputTokens:         in.Usage.InputTokens,
			OutputTokens:        in.Usage.OutputTokens,
			CachedTokens:        in.Usage.CachedTokens,
			CacheReadTokens:     in.Usage.CacheReadTokens,
			CacheCreationTokens: in.Usage.CacheCreationTokens,
		}
	}
	return out
}

func remoteTurnsToLocal(in []*prosav1.Turn) []session.Turn {
	out := make([]session.Turn, 0, len(in))
	for _, t := range in {
		out = append(out, session.Turn{
			Role:      t.Role,
			Content:   t.Content,
			Timestamp: t.Ts.AsTime(),
			Kind:      t.Kind,
			ToolName:  t.ToolName,
		})
	}
	return out
}

func remoteToolsToLocal(in []*prosav1.ToolUsage) []session.ToolUsage {
	out := make([]session.ToolUsage, 0, len(in))
	for _, t := range in {
		out = append(out, session.ToolUsage{Name: t.Name, Count: int(t.Count)})
	}
	return out
}

func copyRaw(rawPath string) error {
	f, err := os.Open(rawPath)
	if err != nil {
		return fmt.Errorf("open raw %s: %w", rawPath, err)
	}
	defer f.Close()
	_, err = io.Copy(os.Stdout, f)
	return err
}

type rawGetter interface {
	GetRaw(context.Context, *connect.Request[prosav1.GetRawRequest]) (*connect.Response[prosav1.GetRawResponse], error)
}

const showRemoteRawChunkLimit = 1 << 20

func copyRemoteRaw(ctx context.Context, id string, w io.Writer) error {
	auth, err := rpc.LoadAuth()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("not logged in — run `prosa login --server <URL>` first")
		}
		return err
	}
	return streamRemoteRaw(ctx, rpc.Sessions(auth.Server, auth.Token), id, w)
}

func streamRemoteRaw(ctx context.Context, client rawGetter, id string, w io.Writer) error {
	var offset int64
	for {
		resp, err := client.GetRaw(ctx, connect.NewRequest(&prosav1.GetRawRequest{
			Id:     id,
			Offset: offset,
			Limit:  showRemoteRawChunkLimit,
		}))
		if err != nil {
			return fmt.Errorf("raw rpc: %s", rpc.ConnectError(err))
		}
		chunk := resp.Msg.Chunk
		if len(chunk) > 0 {
			if _, err := w.Write(chunk); err != nil {
				return err
			}
			offset += int64(len(chunk))
		}
		if resp.Msg.Eof {
			return nil
		}
		if len(chunk) == 0 {
			return errors.New("raw rpc returned an empty non-EOF chunk")
		}
	}
}
