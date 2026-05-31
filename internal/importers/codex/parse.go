package codex

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/c3-oss/prosa/internal/sessiontext"
	"github.com/c3-oss/prosa/pkg/session"
)

const (
	// scanBufferMax matches claudecode — `event_msg.exec_command_end.stdout`
	// can carry multi-megabyte command output, same buffer pressure as
	// Claude's tool_result blocks.
	scanBufferMax = 16 << 20

	scanBufferInitial   = 64 << 10
	firstPromptMaxRunes = 200

	// toolPreviewMaxBytes / toolPreviewMaxLines cap what we project as a
	// tool_result Turn. The raw JSONL is always preserved on disk — these
	// limits only shape the searchable index entry. Constants on purpose:
	// INTENT says no config knobs without three call sites.
	toolPreviewMaxBytes = 4096
	toolPreviewMaxLines = 40
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
	ID  string `json:"id"`
	CWD string `json:"cwd"`
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
}

// functionCallOutput is the inline payload Codex emits for a
// function_call_output response_item. Newer files wrap the output in
// {"type":"function_call_output","output":"..."} or
// {"output":{"content":[{"type":"text","text":"..."}]}}.
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

func hashAndSize(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = f.Close() }()

	h := sha256.New()
	size, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), size, nil
}

// peekSessionID reads only as many lines as needed to find a session_meta
// envelope (the canonical id holder). If absent, falls back to parsing
// the UUID suffix off the filename per docs/sources/codex.md.
func peekSessionID(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, scanBufferInitial), scanBufferMax)
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

// parseSession streams the JSONL once and returns the projected metadata
// plus a UsageState classifying what the parser observed about token
// usage in this transcript. Hash + size are computed separately by
// Import().
func parseSession(ctx context.Context, path string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error) {
	f, err := os.Open(path)
	if err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, err
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, scanBufferInitial), scanBufferMax)

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
			if t, ok := parseTimestamp(r.Timestamp); ok {
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
			// Legacy top-level message record.
			handleLegacyMessage(r.Role, r.Content, r.Timestamp, &sess, &turns, &firstPromptSet)

		case r.Type == "function_call":
			// Legacy top-level function call.
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
			// Legacy top-level tool output.
			text := extractToolOutput(r.Content)
			if text == "" {
				break
			}
			id := legacyCallID(sc.Bytes())
			name := callIDToName[id]
			ts, _ := parseTimestamp(r.Timestamp)
			turns = append(turns, session.Turn{
				Role:      "tool",
				Content:   truncatePreview(text),
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
			ts, _ := parseTimestamp(timestamp)
			*turns = append(*turns, session.Turn{
				Role: "user", Content: text, Timestamp: ts, Kind: session.KindMessage,
			})
		case "assistant":
			ts, _ := parseTimestamp(timestamp)
			*turns = append(*turns, session.Turn{
				Role: "assistant", Content: text, Timestamp: ts, Kind: session.KindMessage,
			})
		}

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
		ts, _ := parseTimestamp(timestamp)
		*turns = append(*turns, session.Turn{
			Role:      "tool",
			Content:   truncatePreview(text),
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
		ts, _ := parseTimestamp(timestamp)
		*turns = append(*turns, session.Turn{
			Role: "user", Content: text, Timestamp: ts, Kind: session.KindMessage,
		})
	case "assistant":
		ts, _ := parseTimestamp(timestamp)
		*turns = append(*turns, session.Turn{
			Role: "assistant", Content: text, Timestamp: ts, Kind: session.KindMessage,
		})
	}
}

// setFirstPromptIfHuman defers cleanup (sanitize + unwrap + drop wholly
// boilerplate) to sessiontext.BuildFirstPrompt — see
// sessiontext/sessiontext.go for the rules. The local wrapper just
// enforces "first wins" semantics so later user messages don't clobber.
func setFirstPromptIfHuman(sess *session.Session, set *bool, text string) {
	if *set {
		return
	}
	prompt, ok := sessiontext.BuildFirstPrompt(text, firstPromptMaxRunes)
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

// legacyCallID best-effort pulls call_id out of a legacy top-level
// function_call / function_call_output record. The rawRecord struct
// doesn't carry it, so we re-decode a tiny shape.
func legacyCallID(line []byte) string {
	var probe struct {
		CallID string `json:"call_id"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		return ""
	}
	return probe.CallID
}

// truncatePreview caps tool output content at toolPreviewMaxLines /
// toolPreviewMaxBytes for the searchable Turn, marking truncation with
// a trailing "…" sentinel. The verbatim raw is always still on disk.
func truncatePreview(s string) string {
	if s == "" {
		return ""
	}
	lines := strings.Split(s, "\n")
	truncated := false
	if len(lines) > toolPreviewMaxLines {
		lines = lines[:toolPreviewMaxLines]
		truncated = true
	}
	out := strings.Join(lines, "\n")
	if len(out) > toolPreviewMaxBytes {
		out = truncateUTF8(out, toolPreviewMaxBytes)
		truncated = true
	}
	if truncated {
		out += "\n…"
	}
	return out
}

func truncateUTF8(s string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(s) <= maxBytes {
		return s
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// extractMessageText returns the joined text for a message's content,
// filtered by the role-appropriate block type. Codex uses:
//   - user      -> content[].type == "input_text"
//   - assistant -> content[].type == "output_text"
//
// Legacy records may carry `content` as a plain string instead of an
// array; that path is handled too.
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

func parseTimestamp(s string) (time.Time, bool) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC(), true
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), true
	}
	return time.Time{}, false
}
