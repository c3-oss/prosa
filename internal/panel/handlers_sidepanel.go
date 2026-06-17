package panel

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/panel/render"
	"github.com/c3-oss/prosa/internal/pricing"
	"github.com/c3-oss/prosa/internal/sessiontext"
)

// handleSessionDetail handles HTMX swap requests like
// GET /sessions/<id> → partial fragment that fills #side-panel.
func (p *Panel) handleSessionDetail(w http.ResponseWriter, r *http.Request) {
	sid := strings.TrimPrefix(r.URL.Path, "/sessions/")
	if sid == "" {
		http.NotFound(w, r)
		return
	}
	sp, err := p.loadSidePanel(r.Context(), sid)
	if err != nil {
		slog.Warn("side panel load failed", "id", sid, "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	p.render(w, r, "side_panel", map[string]any{
		"SidePanel": sp,
	})
}

// handleRawChunk paginates the raw transcript. URL:
// /raw/<id>?offset=N. Returns an HTML fragment that HTMX appends.
func (p *Panel) handleRawChunk(w http.ResponseWriter, r *http.Request) {
	sid := strings.TrimPrefix(r.URL.Path, "/raw/")
	if sid == "" {
		http.NotFound(w, r)
		return
	}
	offset, _ := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	resp, err := p.clients.Sessions.GetRaw(r.Context(), connect.NewRequest(&prosav1.GetRawRequest{
		Id:     sid,
		Offset: offset,
		Limit:  65536,
	}))
	if err != nil {
		slog.Warn("raw chunk failed", "id", sid, "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	chunk := resp.Msg.Chunk
	progress := offset + int64(len(chunk))
	chunkText := string(chunk)
	eof := resp.Msg.Eof
	nextURL := fmt.Sprintf("/raw/%s?offset=%d", sid, progress)
	if isBinaryChunk(chunk) {
		chunkText = binaryPlaceholder(resp.Msg.TotalSize)
		eof = true
		nextURL = ""
	}
	p.render(w, r, "raw_chunk", map[string]any{
		"ID":       sid,
		"Chunk":    chunkText,
		"NextURL":  nextURL,
		"EOF":      eof,
		"Total":    resp.Msg.TotalSize,
		"Progress": progress,
	})
}

// sidePanelData bundles the metadata + first raw chunk the side panel
// renders inline. TurnsCount/ToolsCount/DurationLabel feed the stats
// cluster at the top of the panel; TurnGroups is what the transcript
// section iterates over. Children is the (possibly empty) list of
// subagent sessions spawned from this one; the template renders a
// dedicated "Subagents" disclosure when it's non-empty. All derived in
// loadSidePanel so the template stays declarative.
type sidePanelData struct {
	Session       *prosav1.Session
	Kinds         []string
	Project       projectDisplay
	TokensTotal   string
	TokensIn      string
	TokensOut     string
	Cost          string
	Turns         []render.Turn
	TurnGroups    []render.TurnGroup
	Tools         []*prosav1.ToolUsage
	Children      []*prosav1.Session
	TurnsCount    int
	ToolsCount    int
	DurationLabel string
	Chunk         string
	NextURL       string
	EOF           bool
	Total         int64
	Progress      int64
}

func (p *Panel) loadSidePanel(ctx context.Context, id string) (sidePanelData, error) {
	getResp, err := p.clients.Sessions.Get(ctx, connect.NewRequest(&prosav1.GetRequest{Id: id}))
	if err != nil {
		return sidePanelData{}, err
	}
	rawResp, err := p.clients.Sessions.GetRaw(ctx, connect.NewRequest(&prosav1.GetRawRequest{
		Id:     id,
		Offset: 0,
		Limit:  65536,
	}))
	if err != nil {
		return sidePanelData{}, err
	}
	chunk := rawResp.Msg.Chunk
	chunkText := string(chunk)
	eof := rawResp.Msg.Eof
	if isBinaryChunk(chunk) {
		chunkText = binaryPlaceholder(rawResp.Msg.TotalSize)
		eof = true
	}
	turns := buildDisplayTurns(getResp.Msg.Turns)
	// Children are looked up best-effort: a failure here shouldn't
	// block the sidepanel from rendering. Log + treat as empty.
	var children []*prosav1.Session
	childResp, childErr := p.clients.Sessions.ListChildren(ctx,
		connect.NewRequest(&prosav1.ListChildrenRequest{ParentId: id}))
	if childErr != nil {
		slog.Warn("side panel list children failed", "id", id, "err", childErr)
	} else {
		children = childResp.Msg.Sessions
	}
	sess := getResp.Msg.Session
	usage := tokenUsageFromProto(sess.GetUsage())
	costLabel := "n/a"
	if cost, ok := pricing.CostUSD(sess.GetModel(), usage); ok {
		costLabel = fmt.Sprintf("$%.2f", cost)
	}
	sp := sidePanelData{
		Session:       sess,
		Kinds:         sess.GetKinds(),
		Project:       projectDisplayFromSession(sess),
		TokensTotal:   formatPanelInt(usage.TotalTokens),
		TokensIn:      formatPanelInt(usage.InputTokens),
		TokensOut:     formatPanelInt(usage.OutputTokens),
		Cost:          costLabel,
		Turns:         turns,
		TurnGroups:    render.GroupTurns(turns),
		Tools:         getResp.Msg.Tools,
		Children:      children,
		TurnsCount:    countMessageDisplayTurns(turns),
		ToolsCount:    sumToolCounts(getResp.Msg.Tools),
		DurationLabel: sessionDurationLabel(sess),
		Chunk:         chunkText,
		EOF:           eof,
		Total:         rawResp.Msg.TotalSize,
		Progress:      int64(len(chunk)),
	}
	if !sp.EOF {
		sp.NextURL = fmt.Sprintf("/raw/%s?offset=%d", id, sp.Progress)
	}
	return sp, nil
}

// countMessageDisplayTurns counts user + assistant message turns,
// skipping tool_result and operational rows. The stats cluster's
// "turns" KPI is meant to convey "how many exchanges did I have", not
// "how many DB rows projected".
func countMessageDisplayTurns(in []render.Turn) int {
	n := 0
	for _, t := range in {
		if t.Kind == "tool_result" || t.Kind == "operational" {
			continue
		}
		n++
	}
	return n
}

// sumToolCounts adds up every per-tool invocation count. The list is
// already aggregated server-side; this just collapses it to one number.
func sumToolCounts(in []*prosav1.ToolUsage) int {
	n := 0
	for _, u := range in {
		if u == nil {
			continue
		}
		n += int(u.Count)
	}
	return n
}

// sessionDurationLabel renders the session length as humanDuration
// expects it: "—" when either timestamp is missing, otherwise the
// formatted gap.
func sessionDurationLabel(s *prosav1.Session) string {
	if s == nil || s.StartedAt == nil || s.LastActivityAt == nil {
		return "—"
	}
	return humanDuration(s.LastActivityAt.AsTime().Sub(s.StartedAt.AsTime()))
}

// buildDisplayTurns converts the connect Turn slice into the panel's
// render-ready render.Turn slice. Assistant content is rendered as
// markdown; user and tool content is escaped plain text with newlines
// preserved. ANSI escapes and control characters are stripped first
// so terminal-leaked output stays readable.
//
// Returning fresh render.Turn structs means we never share the
// connect response's protobuf pointers — concurrent requests don't
// race on Content and the proto's embedded sync state stays untouched.
func buildDisplayTurns(in []*prosav1.Turn) []render.Turn {
	if len(in) == 0 {
		return nil
	}
	out := make([]render.Turn, 0, len(in))
	for _, t := range in {
		if t == nil {
			continue
		}
		ts := time.Time{}
		if t.Ts != nil {
			ts = t.Ts.AsTime()
		}
		dt := render.Turn{
			Role:     t.Role,
			Kind:     t.Kind,
			ToolName: t.ToolName,
			Ts:       ts,
		}
		switch t.Role {
		case "assistant":
			dt.Body = render.Markdown(sessiontext.SanitizeForDisplay(t.Content))
		case "user":
			// Boilerplate (system-reminders, slash command wrappers,
			// env_context, …) gets peeled off so the bubble body shows
			// just the human-authored prompt; the wrappers attach as
			// UserExtras for the template to surface as chips/details.
			parsed := sessiontext.ParseUserMessage(t.Content)
			dt.Body = render.PlainText(parsed.Body)
			dt.UserExtras = userExtrasFromParsed(parsed)
		default:
			dt.Body = render.PlainText(sessiontext.SanitizeForDisplay(t.Content))
		}
		out = append(out, dt)
	}
	return out
}

// userExtrasFromParsed lifts the wrapper-derived fields out of a
// sessiontext.UserMessage into render.UserExtras. Returns nil when
// the message had no boilerplate — the template uses that to skip
// the chip/details rendering entirely.
func userExtrasFromParsed(p sessiontext.UserMessage) *render.UserExtras {
	if !p.HasExtras() {
		return nil
	}
	return &render.UserExtras{
		Command:                 p.Command,
		CommandArgs:             p.CommandArgs,
		CommandMessage:          p.CommandMessage,
		Reminders:               p.Reminders,
		EnvContext:              p.EnvContext,
		Instructions:            p.Instructions,
		CollaborationMode:       p.CollaborationMode,
		PermissionsInstructions: p.PermissionsInstructions,
		LocalCommandCaveat:      p.LocalCommandCaveat,
		LocalCommandStdout:      p.LocalCommandStdout,
		LocalCommandStderr:      p.LocalCommandStderr,
		GoalBudget:              p.GoalBudget,
		GoalScaffold:            p.GoalScaffold,
	}
}

// isBinaryChunk reports whether b looks like binary content unfit for a
// <pre>. True when b starts with the SQLite magic header, contains a
// NUL byte in the first sniffN bytes, or has invalid UTF-8 in the same
// head. Empty input returns false — nothing to display, nothing to flag.
func isBinaryChunk(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	const sqliteMagic = "SQLite format 3\x00"
	if bytes.HasPrefix(b, []byte(sqliteMagic)) {
		return true
	}
	const sniffN = 4096
	head := b
	if len(head) > sniffN {
		head = head[:sniffN]
	}
	if bytes.IndexByte(head, 0x00) >= 0 {
		return true
	}
	if !validUTF8Sniff(head) {
		return true
	}
	return false
}

func validUTF8Sniff(head []byte) bool {
	for len(head) > 0 {
		r, size := utf8.DecodeRune(head)
		if r == utf8.RuneError && size == 1 {
			need := utf8SequenceLen(head[0])
			if need == 0 || need <= len(head) {
				return false
			}
			// The sniff window can end in the middle of a valid text rune.
			// Treat that as text; the next raw chunk/page owns the remainder.
			return true
		}
		head = head[size:]
	}
	return true
}

func utf8SequenceLen(b byte) int {
	switch {
	case b < utf8.RuneSelf:
		return 1
	case b >= 0xC2 && b <= 0xDF:
		return 2
	case b >= 0xE0 && b <= 0xEF:
		return 3
	case b >= 0xF0 && b <= 0xF4:
		return 4
	default:
		return 0
	}
}

// binaryPlaceholder is the human-readable message shown in the side
// panel in place of binary raw transcripts (e.g. Cursor store.db files
// that the importer preserves verbatim for re-import audit).
func binaryPlaceholder(total int64) string {
	return fmt.Sprintf("Binary content (%d bytes, preserved verbatim) — not displayable as text.", total)
}

// humanDuration is a panel-side wrapper around render.HumanDuration —
// kept for backwards-compat with sessionDurationLabel. The canonical
// implementation lives in internal/panel/render so the transcript
// divider can share the format with the stats cluster.
func humanDuration(d time.Duration) string {
	return render.HumanDuration(d)
}
