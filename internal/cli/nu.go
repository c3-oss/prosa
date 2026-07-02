package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/cli/rpc"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/session"
)

// runNu implements the bare `prosa` invocation: list sessions in the window.
func runNu(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}

	if g.Limit < 0 {
		return fmt.Errorf("--limit must be >= 0")
	}

	now := time.Now().UTC()
	w, err := ResolveWindow(cmd, g.Last, g.Since, g.Between, now)
	if err != nil {
		return err
	}
	if g.Remote {
		return runNuRemote(ctx, w, now)
	}
	storePath, err := paths.StorePath()
	if err != nil {
		return err
	}
	s, err := store.OpenReadOnly(ctx, storePath)
	if err != nil {
		return err
	}
	defer func() { _ = s.Close() }()

	interactive := IsInteractive()
	filter := store.SessionFilter{
		Since: w.Since,
		Until: w.Until,
		Limit: g.Limit,
	}
	projectScope := ResolveProjectScope(ctx, g, s)
	projectScope.ApplySessionFilter(&filter)

	if g.Agent != "" {
		a := g.Agent
		filter.Agent = &a
	}
	if g.Device != "" {
		d := g.Device
		filter.DeviceName = &d
	}
	if g.Profile != "" {
		p := g.Profile
		filter.Profile = &p
	}

	sessions, err := s.ListSessions(ctx, filter)
	if err != nil {
		return err
	}

	if g.JSON {
		return emitTimelineJSON(os.Stdout, sessions)
	}

	items := make([]render.TimelineItem, len(sessions))
	for i := range sessions {
		tools, err := s.GetSessionTools(ctx, sessions[i].ID)
		if err != nil {
			return err
		}
		items[i] = render.TimelineItem{Session: sessions[i], Tools: tools}
	}
	layout := render.TimelineGlobal
	if g.Project != "" || filter.ProjectExact != nil || filter.ProjectRemote != nil || filter.ProjectMarker != nil {
		layout = render.TimelineScoped
	}
	slots, uniform := render.ResolveSlots(items, layout)
	deviceLabels, derr := s.ListDevicesMap(ctx)
	if derr != nil {
		deviceLabels = nil // render falls back to truncated hex
	}

	if interactive {
		fmt.Fprintln(os.Stderr, render.ContextLine(render.ContextLineOptions{
			Command:        "prosa",
			Source:         "local",
			Scope:          projectScope.Scope,
			ScopeLabel:     projectScope.Label,
			Last:           w.LastLabel,
			Since:          w.SinceLabel,
			Between:        w.BetweenLabel,
			UniformProject: uniformProjectSegment(uniform, layout),
			UniformDevice:  uniformDeviceSegment(uniform, deviceLabels),
		}))
	}

	if len(sessions) == 0 {
		if interactive {
			if projectScope.Label != "" {
				fmt.Fprintf(os.Stderr, "no sessions found for %s\n", projectScope.Label)
				fmt.Fprintln(os.Stderr, "use `prosa --all` to show every project")
				return nil
			}
			fmt.Fprintln(os.Stderr, "no sessions found")
			fmt.Fprintln(os.Stderr, "run `prosa sync` to import local agent history")
			return nil
		}
		fmt.Fprintf(os.Stderr, "no sessions %s\n", WindowDescriptor(w))
		return nil
	}

	return render.TimelineItems(os.Stdout, items, now, render.TimelineOptions{
		Interactive:  interactive,
		Width:        TerminalWidth(),
		Layout:       layout,
		Slots:        slots,
		DeviceLabels: deviceLabels,
	})
}

// uniformProjectSegment names the single project behind a suppressed
// column. Scoped layouts skip it — the scope label already names it.
func uniformProjectSegment(uniform render.UniformValues, layout render.TimelineLayout) string {
	if layout == render.TimelineScoped {
		return ""
	}
	return uniform.Project
}

func uniformDeviceSegment(uniform render.UniformValues, deviceLabels map[string]string) string {
	if uniform.DeviceID == "" {
		return ""
	}
	return render.DeviceLabel(deviceLabels, uniform.DeviceID)
}

func runNuRemote(ctx context.Context, w Window, now time.Time) error {
	auth, err := rpc.LoadAuth()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("not logged in — run `prosa login --server <URL>` first")
		}
		return err
	}
	req := &prosav1.ListRequest{
		Since: timestamppb.New(w.Since),
		Until: timestamppb.New(w.Until),
		Limit: int32(g.Limit),
	}
	projectScope := ResolveProjectScopeFromLocalStore(ctx, g)
	projectScope.ApplyListRequest(req)
	if g.Agent != "" {
		req.Agent = g.Agent
	}
	if g.Device != "" {
		req.DeviceName = g.Device
	}
	if g.Profile != "" {
		req.Profile = g.Profile
	}

	interactive := IsInteractive()

	client := rpc.Sessions(auth.Server, auth.Token)
	resp, err := client.List(ctx, connect.NewRequest(req))
	if err != nil {
		return fmt.Errorf("list rpc: %s", rpc.ConnectError(err))
	}
	sessions := make([]session.Session, 0, len(resp.Msg.Sessions))
	for _, in := range resp.Msg.Sessions {
		sessions = append(sessions, remoteSessionToLocal(in))
	}
	if g.JSON {
		return emitTimelineJSON(os.Stdout, sessions)
	}

	items := make([]render.TimelineItem, len(sessions))
	for i := range sessions {
		items[i] = render.TimelineItem{Session: sessions[i]}
	}
	layout := render.TimelineGlobal
	if g.Project != "" || req.ProjectPath != "" || req.ProjectRemote != "" || req.ProjectMarker != "" {
		layout = render.TimelineScoped
	}
	slots, uniform := render.ResolveSlots(items, layout)
	deviceLabels := remoteDeviceLabels(ctx, auth)

	if interactive {
		fmt.Fprintln(os.Stderr, render.ContextLine(render.ContextLineOptions{
			Command:        "prosa",
			Source:         "remote",
			Scope:          projectScope.Scope,
			ScopeLabel:     projectScope.Label,
			Last:           w.LastLabel,
			Since:          w.SinceLabel,
			Between:        w.BetweenLabel,
			UniformProject: uniformProjectSegment(uniform, layout),
			UniformDevice:  uniformDeviceSegment(uniform, deviceLabels),
		}))
	}

	if len(sessions) == 0 {
		if interactive {
			if projectScope.Label != "" {
				fmt.Fprintf(os.Stderr, "no sessions found for %s\n", projectScope.Label)
				fmt.Fprintln(os.Stderr, "use `prosa --all` to show every project")
				return nil
			}
			fmt.Fprintln(os.Stderr, "no sessions found")
			return nil
		}
		fmt.Fprintf(os.Stderr, "no sessions %s\n", WindowDescriptor(w))
		return nil
	}

	return render.TimelineItems(os.Stdout, items, now, render.TimelineOptions{
		Interactive:  interactive,
		Width:        TerminalWidth(),
		Layout:       layout,
		Slots:        slots,
		DeviceLabels: deviceLabels,
	})
}

type timelineSessionJSON struct {
	ID             string             `json:"id"`
	Agent          string             `json:"agent"`
	DeviceID       string             `json:"device_id"`
	Project        string             `json:"project,omitempty"`
	ProjectPath    string             `json:"project_path,omitempty"`
	ProjectRemote  string             `json:"project_remote,omitempty"`
	ProjectMarker  string             `json:"project_marker,omitempty"`
	StartedAt      time.Time          `json:"started_at"`
	LastActivityAt time.Time          `json:"last_activity_at"`
	FirstPrompt    string             `json:"first_prompt,omitempty"`
	Model          string             `json:"model,omitempty"`
	RawPath        string             `json:"raw_path,omitempty"`
	RawHash        string             `json:"raw_hash,omitempty"`
	RawSize        int64              `json:"raw_size,omitempty"`
	Usage          *timelineUsageJSON `json:"usage,omitempty"`
	ParentID       string             `json:"parent_session_id,omitempty"`
	Profile        string             `json:"profile"`
	Kinds          []string           `json:"kinds,omitempty"`
}

type timelineUsageJSON struct {
	TotalTokens         int64 `json:"total_tokens"`
	InputTokens         int64 `json:"input_tokens"`
	OutputTokens        int64 `json:"output_tokens"`
	CachedTokens        int64 `json:"cached_tokens"`
	CacheReadTokens     int64 `json:"cache_read_tokens"`
	CacheCreationTokens int64 `json:"cache_creation_tokens"`
}

func emitTimelineJSON(w io.Writer, sessions []session.Session) error {
	enc := json.NewEncoder(w)
	for i := range sessions {
		if err := enc.Encode(timelineSessionPayload(sessions[i])); err != nil {
			return err
		}
	}
	return nil
}

func timelineSessionPayload(s session.Session) timelineSessionJSON {
	out := timelineSessionJSON{
		ID:             s.ID,
		Agent:          s.Agent,
		DeviceID:       s.DeviceID,
		ProjectPath:    ptrText(s.ProjectPath),
		ProjectRemote:  ptrText(s.ProjectRemote),
		ProjectMarker:  ptrText(s.ProjectMarker),
		StartedAt:      s.StartedAt,
		LastActivityAt: s.LastActivityAt,
		FirstPrompt:    ptrText(s.FirstPrompt),
		Model:          ptrText(s.Model),
		RawPath:        s.RawPath,
		RawHash:        s.RawHash,
		RawSize:        s.RawSize,
		Usage:          timelineUsagePayload(s.Usage),
		ParentID:       ptrText(s.ParentSessionID),
		Profile:        session.ProfileOrDefault(s.Profile),
	}
	out.Project = timelineProject(out.ProjectPath, out.ProjectRemote, out.ProjectMarker)
	if len(s.Kinds) > 0 {
		out.Kinds = append([]string(nil), s.Kinds...)
	}
	return out
}

func timelineProject(path, remote, marker string) string {
	switch {
	case marker != "":
		return marker
	case remote != "":
		return remote
	default:
		return path
	}
}

func timelineUsagePayload(u *session.TokenUsage) *timelineUsageJSON {
	if u == nil {
		return nil
	}
	return &timelineUsageJSON{
		TotalTokens:         u.TotalTokens,
		InputTokens:         u.InputTokens,
		OutputTokens:        u.OutputTokens,
		CachedTokens:        u.CachedTokens,
		CacheReadTokens:     u.CacheReadTokens,
		CacheCreationTokens: u.CacheCreationTokens,
	}
}

func ptrText(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func remoteDeviceLabels(ctx context.Context, auth rpc.AuthFile) map[string]string {
	client := rpc.Devices(auth.Server, auth.Token)
	resp, err := client.List(ctx, connect.NewRequest(&prosav1.DevicesServiceListRequest{}))
	if err != nil {
		return nil
	}
	out := make(map[string]string, len(resp.Msg.Devices))
	for _, d := range resp.Msg.Devices {
		label := d.FriendlyName
		if label == "" {
			label = d.Hostname
		}
		if label != "" {
			out[d.Id] = label
		}
	}
	return out
}
