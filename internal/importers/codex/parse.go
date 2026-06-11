package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/internal/sessiontext"
	"github.com/c3-oss/prosa/pkg/session"
)

// uuidSuffixRE pulls the session UUID out of a Codex filename suffix
// when session_meta is missing (older files / corrupt headers).
var uuidSuffixRE = regexp.MustCompile(
	`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
)

// rawRecord carries fields from both record shapes Codex emits:
//   - Envelope: {type, timestamp, payload}.
//   - Legacy:   {type, role/content/name/...} at top level (no payload).
//
// json.Unmarshal silently leaves the absent fields zero-valued, which is
// exactly how we want to discriminate without a second pass.
type rawRecord struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp"`
	Payload   json.RawMessage `json:"payload,omitempty"`

	// Legacy top-level fields used when Payload is empty.
	Role    string          `json:"role,omitempty"`
	Content json.RawMessage `json:"content,omitempty"`
	Name    string          `json:"name,omitempty"`
}

type sessionMetaPayload struct {
	ID     string             `json:"id"`
	CWD    string             `json:"cwd"`
	Source *sessionMetaSource `json:"source"`
}

// sessionMetaSource carries the optional subagent / spawn metadata
// emitted by Codex when a session was started by another session
// (its agent_tool, exec_command, etc.). Nil for top-level sessions.
type sessionMetaSource struct {
	Subagent *sessionMetaSubagent `json:"subagent"`
}

type sessionMetaSubagent struct {
	ThreadSpawn *sessionMetaThreadSpawn `json:"thread_spawn"`
}

type sessionMetaThreadSpawn struct {
	ParentThreadID string `json:"parent_thread_id"`
}

type turnContextPayload struct {
	Model string `json:"model"`
	CWD   string `json:"cwd"`
}

type responseItemPayload struct {
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Name    string          `json:"name"`
	CallID  string          `json:"call_id"`
	Output  json.RawMessage `json:"output"`
	Content json.RawMessage `json:"content"`
	Summary json.RawMessage `json:"summary"`
}

// functionCallOutput is the payload Codex emits for a function_call_output
// response_item. Output may be a plain string or a content-block wrapper.
type functionCallOutput struct {
	Output  json.RawMessage  `json:"output"`
	Content []functionOutBlk `json:"content"`
}

type functionOutBlk struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type eventMsgPayload struct {
	Type string          `json:"type"`
	Info *tokenCountInfo `json:"info"`
}

type tokenCountInfo struct {
	TotalTokenUsage *tokenUsageJSON `json:"total_token_usage"`
	LastTokenUsage  *tokenUsageJSON `json:"last_token_usage"`
}

type tokenUsageJSON struct {
	InputTokens          int64 `json:"input_tokens"`
	OutputTokens         int64 `json:"output_tokens"`
	TotalTokens          int64 `json:"total_tokens"`
	CachedInputTokens    int64 `json:"cached_input_tokens"`
	CacheReadInputTokens int64 `json:"cache_read_input_tokens"`
}

// peekSessionID returns the session ID from the first session_meta record,
// falling back to the UUID suffix in the filename.
func peekSessionID(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, importerutil.ScanBufferInitial), importerutil.ScanBufferMax)
	for sc.Scan() {
		var r rawRecord
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			continue
		}
		if r.Type == "session_meta" && len(r.Payload) > 0 {
			var p sessionMetaPayload
			if err := json.Unmarshal(r.Payload, &p); err == nil && p.ID != "" {
				return p.ID, nil
			}
		}
	}
	if err := sc.Err(); err != nil && !errors.Is(err, bufio.ErrTooLong) {
		return "", err
	}

	base := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	if m := uuidSuffixRE.FindStringSubmatch(base); m != nil {
		return m[1], nil
	}
	return base, nil
}

// parseSession streams the JSONL once and returns the projected session,
// turns, tool usages, and a UsageState. Hash + size are computed by Import.
func parseSession(ctx context.Context, path string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error) {
	f, err := os.Open(path)
	if err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, err
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, importerutil.ScanBufferInitial), importerutil.ScanBufferMax)

	var (
		sess           session.Session
		turns          []session.Turn
		toolCounts     = map[string]int{}
		callIDToName   = map[string]string{}
		bestUsage      *session.TokenUsage
		sessIDSet      bool
		cwdSet         bool
		modelSet       bool
		firstPromptSet bool
		seenUsageEvent bool
		line           int
	)

	for sc.Scan() {
		line++
		if err := ctx.Err(); err != nil {
			return session.Session{}, nil, nil, session.UsageStateUnknown, err
		}

		var r rawRecord
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			slog.Warn("codex: malformed JSONL line skipped",
				"path", path, "line", line, "err", err)
			continue
		}

		if r.Timestamp != "" {
			if t, ok := importerutil.ParseRFC3339(r.Timestamp); ok {
				if sess.StartedAt.IsZero() || t.Before(sess.StartedAt) {
					sess.StartedAt = t
				}
				if t.After(sess.LastActivityAt) {
					sess.LastActivityAt = t
				}
			}
		}

		switch {
		case r.Type == "session_meta" && len(r.Payload) > 0:
			var p sessionMetaPayload
			if err := json.Unmarshal(r.Payload, &p); err != nil {
				continue
			}
			if !sessIDSet && p.ID != "" {
				sess.ID = p.ID
				sessIDSet = true
			}
			if !cwdSet && p.CWD != "" {
				cwd := p.CWD
				sess.ProjectPath = &cwd
				cwdSet = true
			}
			if sess.ParentSessionID == nil &&
				p.Source != nil && p.Source.Subagent != nil &&
				p.Source.Subagent.ThreadSpawn != nil &&
				p.Source.Subagent.ThreadSpawn.ParentThreadID != "" {
				parent := p.Source.Subagent.ThreadSpawn.ParentThreadID
				sess.ParentSessionID = &parent
			}

		case r.Type == "turn_context" && len(r.Payload) > 0:
			var p turnContextPayload
			if err := json.Unmarshal(r.Payload, &p); err != nil {
				continue
			}
			if !modelSet && p.Model != "" {
				m := p.Model
				sess.Model = &m
				modelSet = true
			}
			if !cwdSet && p.CWD != "" {
				cwd := p.CWD
				sess.ProjectPath = &cwd
				cwdSet = true
			}

		case r.Type == "response_item" && len(r.Payload) > 0:
			var p responseItemPayload
			if err := json.Unmarshal(r.Payload, &p); err != nil {
				continue
			}
			handleResponseItem(p, r.Timestamp, &sess, &turns, &firstPromptSet, toolCounts, callIDToName)

		case r.Type == "event_msg" && len(r.Payload) > 0:
			usage, isUsageEvent, hasUsage := tokenUsageFromEvent(r.Payload)
			if isUsageEvent {
				// Any token_count event counts as "we saw usage",
				// even when its totals come back zero — that's
				// what distinguishes explicit-zero from no-event-
				// at-all sessions for the import classifier.
				seenUsageEvent = true
			}
			if hasUsage {
				if bestUsage == nil || usage.TotalTokens >= bestUsage.TotalTokens {
					u := usage
					bestUsage = &u
				}
			}

		case r.Type == "message":
			handleLegacyMessage(r.Role, r.Content, r.Timestamp, &sess, &turns, &firstPromptSet)

		case r.Type == "function_call":
			if r.Name != "" {
				toolCounts[r.Name]++
				// Legacy records carry the call_id alongside; round-trip
				// it via the raw payload so function_call_output can find
				// the tool name later.
				if id := legacyCallID(sc.Bytes()); id != "" {
					callIDToName[id] = r.Name
				}
			}

		case r.Type == "function_call_output":
			text := extractToolOutput(r.Content)
			if text == "" {
				break
			}
			id := legacyCallID(sc.Bytes())
			name := callIDToName[id]
			ts, _ := importerutil.ParseRFC3339(r.Timestamp)
			turns = append(turns, session.Turn{
				Role:      "tool",
				Content:   importerutil.TruncatePreview(text),
				Timestamp: ts,
				Kind:      session.KindToolResult,
				ToolName:  name,
			})
		}
	}

	if err := sc.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			slog.Warn("codex: JSONL line exceeded 16 MiB scan buffer; partial session",
				"path", path, "line", line+1)
		} else {
			return session.Session{}, nil, nil, session.UsageStateUnknown, fmt.Errorf("scan %s: %w", path, err)
		}
	}

	tools := make([]session.ToolUsage, 0, len(toolCounts))
	for name, count := range toolCounts {
		tools = append(tools, session.ToolUsage{Name: name, Count: count})
	}
	if bestUsage != nil {
		sess.Usage = bestUsage
	}
	state := session.ClassifyUsage(seenUsageEvent, sess.Usage)
	return sess, turns, tools, state, nil
}

// tokenUsageFromEvent decodes a Codex event_msg payload. isUsageEvent
// is true whenever the payload type is "token_count" regardless of
// whether the totals are present or zero — callers use that to
// distinguish "session ran without token reporting" (no event) from
// "session reported zero tokens" (event with zeros). hasUsage is true
// only when at least one token field is positive.
func tokenUsageFromEvent(raw json.RawMessage) (usage session.TokenUsage, isUsageEvent, hasUsage bool) {
	var p eventMsgPayload
	if err := json.Unmarshal(raw, &p); err != nil || p.Type != "token_count" {
		return session.TokenUsage{}, false, false
	}
	if p.Info == nil {
		return session.TokenUsage{}, true, false
	}
	src := p.Info.TotalTokenUsage
	if src == nil {
		src = p.Info.LastTokenUsage
	}
	if src == nil {
		return session.TokenUsage{}, true, false
	}
	cached := src.CachedInputTokens
	if cached == 0 {
		cached = src.CacheReadInputTokens
	}
	if cached > src.InputTokens {
		cached = src.InputTokens
	}
	total := src.TotalTokens
	if total == 0 {
		total = src.InputTokens + src.OutputTokens
	}
	if total == 0 && src.InputTokens == 0 && src.OutputTokens == 0 && cached == 0 {
		return session.TokenUsage{}, true, false
	}
	return session.TokenUsage{
		TotalTokens:     total,
		InputTokens:     src.InputTokens,
		OutputTokens:    src.OutputTokens,
		CachedTokens:    cached,
		CacheReadTokens: cached,
	}, true, true
}

func handleResponseItem(
	p responseItemPayload,
	timestamp string,
	sess *session.Session,
	turns *[]session.Turn,
	firstPromptSet *bool,
	toolCounts map[string]int,
	callIDToName map[string]string,
) {
	switch p.Type {
	case "message":
		text := extractMessageText(p.Content, p.Role)
		if text == "" {
			return
		}
		// `developer` and `system` roles never show up as first-prompt
		// candidates — they hold scaffolding ("You are Codex, a coding
		// agent", etc.) that sessiontext.IsBoilerplatePrompt would also
		// flag, but skipping them outright avoids creating a turn for
		// every system message.
		switch p.Role {
		case "user":
			setFirstPromptIfHuman(sess, firstPromptSet, text)
			ts, _ := importerutil.ParseRFC3339(timestamp)
			*turns = append(*turns, session.Turn{
				Role: "user", Content: text, Timestamp: ts, Kind: session.KindMessage,
			})
		case "assistant":
			ts, _ := importerutil.ParseRFC3339(timestamp)
			*turns = append(*turns, session.Turn{
				Role: "assistant", Content: text, Timestamp: ts, Kind: session.KindMessage,
			})
		}

	case "reasoning":
		// Codex's reasoning items carry either a plain string summary
		// or a list of `{type:"summary_text", text:"…"}` blocks. The
		// encrypted_content field is opaque and ignored — only the
		// human-readable summary becomes a KindThinking turn.
		text := extractReasoningSummary(p.Summary)
		if text == "" {
			return
		}
		ts, _ := importerutil.ParseRFC3339(timestamp)
		*turns = append(*turns, session.Turn{
			Role:      "assistant",
			Content:   importerutil.TruncatePreview(text),
			Timestamp: ts,
			Kind:      session.KindThinking,
		})

	case "function_call":
		if p.Name != "" {
			toolCounts[p.Name]++
			if p.CallID != "" {
				callIDToName[p.CallID] = p.Name
			}
		}

	case "function_call_output":
		text := extractToolOutput(p.Output)
		if text == "" {
			return
		}
		name := p.Name
		if name == "" && p.CallID != "" {
			name = callIDToName[p.CallID]
		}
		ts, _ := importerutil.ParseRFC3339(timestamp)
		*turns = append(*turns, session.Turn{
			Role:      "tool",
			Content:   importerutil.TruncatePreview(text),
			Timestamp: ts,
			Kind:      session.KindToolResult,
			ToolName:  name,
		})
	}
}

func handleLegacyMessage(
	role string,
	content json.RawMessage,
	timestamp string,
	sess *session.Session,
	turns *[]session.Turn,
	firstPromptSet *bool,
) {
	text := extractMessageText(content, role)
	if text == "" {
		return
	}
	switch role {
	case "user":
		setFirstPromptIfHuman(sess, firstPromptSet, text)
		ts, _ := importerutil.ParseRFC3339(timestamp)
		*turns = append(*turns, session.Turn{
			Role: "user", Content: text, Timestamp: ts, Kind: session.KindMessage,
		})
	case "assistant":
		ts, _ := importerutil.ParseRFC3339(timestamp)
		*turns = append(*turns, session.Turn{
			Role: "assistant", Content: text, Timestamp: ts, Kind: session.KindMessage,
		})
	}
}

// setFirstPromptIfHuman sets sess.FirstPrompt via sessiontext.BuildFirstPrompt,
// enforcing first-wins: later user messages never clobber an already-set value.
func setFirstPromptIfHuman(sess *session.Session, set *bool, text string) {
	if *set {
		return
	}
	prompt, ok := sessiontext.BuildFirstPrompt(text, importerutil.FirstPromptMaxRunes)
	if !ok {
		return
	}
	sess.FirstPrompt = &prompt
	*set = true
}

// extractToolOutput pulls the textual body out of a function_call_output
// payload. Codex emits either a plain string or a Connect/Responses
// API style {"content":[{"type":"text","text":"..."}]} wrapper.
func extractToolOutput(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
	}
	var wrap functionCallOutput
	if err := json.Unmarshal(raw, &wrap); err == nil {
		if len(wrap.Output) > 0 {
			var inner string
			if err := json.Unmarshal(wrap.Output, &inner); err == nil {
				return inner
			}
		}
		if len(wrap.Content) > 0 {
			parts := make([]string, 0, len(wrap.Content))
			for _, b := range wrap.Content {
				if b.Text != "" {
					parts = append(parts, b.Text)
				}
			}
			return strings.Join(parts, "\n")
		}
	}
	return ""
}

// legacyCallID extracts call_id from a raw line; rawRecord doesn't carry it,
// so a minimal re-decode is needed.
func legacyCallID(line []byte) string {
	var probe struct {
		CallID string `json:"call_id"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		return ""
	}
	return probe.CallID
}

// extractReasoningSummary returns the textual summary of a Codex reasoning
// item. Two shapes seen in the wild:
//
//   - plain string:  "summary": "I considered three options …"
//   - block list:    "summary": [{"type":"summary_text","text":"…"}, …]
//
// Returns "" when neither shape matches, so the caller skips an empty turn.
func extractReasoningSummary(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return strings.TrimSpace(asString)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Text == "" {
			continue
		}
		if b.Type == "" || b.Type == "summary_text" || b.Type == "text" {
			parts = append(parts, b.Text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

// extractMessageText returns joined text from a message's content, selecting
// the role-appropriate block type (input_text for user, output_text for
// assistant). Legacy records may carry content as a plain string.
func extractMessageText(content json.RawMessage, role string) string {
	if len(content) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(content, &asString); err == nil {
		return asString
	}
	var blocks []contentBlock
	if err := json.Unmarshal(content, &blocks); err != nil {
		return ""
	}
	want := ""
	switch role {
	case "user":
		want = "input_text"
	case "assistant":
		want = "output_text"
	default:
		return ""
	}
	var parts []string
	for _, b := range blocks {
		// Some legacy blocks have only a `text` field with no `type`.
		// We accept those when role matches; the safe assumption is the
		// block belongs to the speaker.
		if (b.Type == want || b.Type == "") && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}
