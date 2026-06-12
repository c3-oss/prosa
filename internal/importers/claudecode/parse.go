package claudecode

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/internal/sessiontext"
	"github.com/c3-oss/prosa/pkg/session"
)

type rawRecord struct {
	Type        string          `json:"type"`
	SessionID   string          `json:"sessionId"`
	UUID        string          `json:"uuid"`
	RequestID   string          `json:"requestId"`
	Timestamp   string          `json:"timestamp"`
	CWD         string          `json:"cwd"`
	IsSidechain bool            `json:"isSidechain"`
	IsMeta      bool            `json:"isMeta"`
	Message     json.RawMessage `json:"message"`
}

type rawMessage struct {
	Role    string          `json:"role"`
	ID      string          `json:"id"`
	Model   string          `json:"model"`
	Content json.RawMessage `json:"content"`
	Usage   *claudeUsage    `json:"usage"`
}

type rawContentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	Name      string          `json:"name"`
	ID        string          `json:"id"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
}

type claudeUsage struct {
	InputTokens              int64                    `json:"input_tokens"`
	OutputTokens             int64                    `json:"output_tokens"`
	CacheReadInputTokens     int64                    `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64                    `json:"cache_creation_input_tokens"`
	CacheCreation            claudeCacheCreationUsage `json:"cache_creation"`
}

type claudeCacheCreationUsage struct {
	Ephemeral5mInputTokens int64 `json:"ephemeral_5m_input_tokens"`
	Ephemeral1hInputTokens int64 `json:"ephemeral_1h_input_tokens"`
}

// peekSessionID reads only as many lines as needed to find the first
// sessionId field, then returns. Falls back to the filename (sans .jsonl)
// if no record carries one. Subagent transcripts short-circuit to the
// filename stem: their records carry the parent's sessionId, not their own.
func peekSessionID(path string) (string, error) {
	if id := subagentSessionIDFromPath(path); id != "" {
		return id, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, importerutil.ScanBufferInitial), importerutil.ScanBufferMax)
	for sc.Scan() {
		var r rawRecord
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			continue
		}
		if r.SessionID != "" {
			return r.SessionID, nil
		}
	}
	if err := sc.Err(); err != nil && !errors.Is(err, bufio.ErrTooLong) {
		return "", err
	}
	return strings.TrimSuffix(filepath.Base(path), ".jsonl"), nil
}

// parseSession streams the JSONL once and returns the projected metadata
// plus a UsageState classifying whether the transcript carried any usage
// event (and if so, whether totals were positive).
func parseSession(ctx context.Context, path string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error) {
	f, err := os.Open(path)
	if err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, importerutil.ScanBufferInitial), importerutil.ScanBufferMax)

	var (
		sess            session.Session
		turns           []session.Turn
		toolCounts      = map[string]int{}
		toolUseIDToName = map[string]string{}
		usageByKey      = map[string]claudeUsage{}
		sessIDSet       bool
		cwdSet          bool
		modelSet        bool
		firstPromptSet  bool
		line            int
	)

	// Subagent transcripts live under `<parent-uuid>/subagents/` and
	// every record inside carries the parent's sessionId. Identity comes
	// from the filename stem instead — set before the scan so the loop
	// never adopts the parent's id — and the parent edge from the
	// directory two levels up, when it is UUID-shaped.
	if id := subagentSessionIDFromPath(path); id != "" {
		sess.ID = id
		sessIDSet = true
		if parent := parentSessionIDFromPath(path); parent != "" {
			sess.ParentSessionID = &parent
		}
	}

	for sc.Scan() {
		line++
		if err := ctx.Err(); err != nil {
			return session.Session{}, nil, nil, session.UsageStateUnknown, err
		}

		var r rawRecord
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			slog.Warn("claude-code: malformed JSONL line skipped",
				"path", path, "line", line, "err", err)
			continue
		}

		if !sessIDSet && r.SessionID != "" {
			sess.ID = r.SessionID
			sessIDSet = true
		}
		if !cwdSet && r.CWD != "" {
			cwd := r.CWD
			sess.ProjectPath = &cwd
			cwdSet = true
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

		switch r.Type {
		case "user":
			if r.IsMeta {
				continue
			}
			ts, _ := importerutil.ParseRFC3339(r.Timestamp)
			content := extractUserText(r.Message)
			if content != "" {
				setFirstPromptIfHuman(&sess, &firstPromptSet, content)
				cleaned := strings.TrimSpace(sessiontext.CleanPrompt(content))
				if cleaned == "" {
					cleaned = content
				}
				turns = append(turns, session.Turn{
					Role:      "user",
					Content:   cleaned,
					Timestamp: ts,
					Kind:      session.KindMessage,
				})
			}
			for _, tr := range extractToolResults(r.Message, toolUseIDToName) {
				turns = append(turns, session.Turn{
					Role:      "tool",
					Content:   importerutil.TruncatePreview(tr.text),
					Timestamp: ts,
					Kind:      session.KindToolResult,
					ToolName:  tr.toolName,
				})
			}

		case "assistant":
			collectUsage(r, line, usageByKey)
			text := extractAssistantText(r.Message)
			if text != "" {
				ts, _ := importerutil.ParseRFC3339(r.Timestamp)
				turns = append(turns, session.Turn{
					Role:      "assistant",
					Content:   text,
					Timestamp: ts,
					Kind:      session.KindMessage,
				})
			}
			for _, thinking := range extractAssistantThinking(r.Message) {
				ts, _ := importerutil.ParseRFC3339(r.Timestamp)
				turns = append(turns, session.Turn{
					Role:      "assistant",
					Content:   importerutil.TruncatePreview(thinking),
					Timestamp: ts,
					Kind:      session.KindThinking,
				})
			}
			if !modelSet {
				if m := extractModel(r.Message); m != "" {
					if !isSyntheticModel(m) {
						mm := m
						sess.Model = &mm
						modelSet = true
					}
				}
			}
			collectToolUses(r.Message, toolCounts, toolUseIDToName)
		}
	}

	if err := sc.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			slog.Warn("claude-code: JSONL line exceeded 16 MiB scan buffer; partial session",
				"path", path, "line", line+1)
		} else {
			return session.Session{}, nil, nil, session.UsageStateUnknown, fmt.Errorf("scan %s: %w", path, err)
		}
	}

	tools := make([]session.ToolUsage, 0, len(toolCounts))
	for name, count := range toolCounts {
		tools = append(tools, session.ToolUsage{Name: name, Count: count})
	}
	if usage := buildClaudeUsage(usageByKey); usage != nil {
		sess.Usage = usage
	}
	// Any populated usageByKey entry means we observed at least one
	// assistant.message.usage block — even if every field came back
	// zero. That distinguishes a transcript with explicit-zero usage
	// (skip as no_usage) from one that never had a usage event at all
	// (admit as unknown).
	state := session.ClassifyUsage(len(usageByKey) > 0, sess.Usage)
	return sess, turns, tools, state, nil
}

func collectUsage(r rawRecord, line int, usageByKey map[string]claudeUsage) {
	if len(r.Message) == 0 {
		return
	}
	var m rawMessage
	if err := json.Unmarshal(r.Message, &m); err != nil || m.Usage == nil {
		return
	}
	key := r.RequestID
	if key == "" {
		key = m.ID
	}
	if key == "" {
		key = r.UUID
	}
	if key == "" {
		key = fmt.Sprintf("line:%d", line)
	}
	if prev, ok := usageByKey[key]; !ok || canonicalClaudeUsage(*m.Usage) >= canonicalClaudeUsage(prev) {
		usageByKey[key] = *m.Usage
	}
}

func buildClaudeUsage(usageByKey map[string]claudeUsage) *session.TokenUsage {
	if len(usageByKey) == 0 {
		return nil
	}
	var out session.TokenUsage
	for _, u := range usageByKey {
		cacheCreation := u.cacheCreationTokens()
		input := u.InputTokens + u.CacheReadInputTokens + cacheCreation
		out.InputTokens += input
		out.OutputTokens += u.OutputTokens
		out.CachedTokens += u.CacheReadInputTokens
		out.CacheReadTokens += u.CacheReadInputTokens
		out.CacheCreationTokens += cacheCreation
		out.TotalTokens += input + u.OutputTokens
	}
	if out.TotalTokens == 0 && out.InputTokens == 0 && out.OutputTokens == 0 {
		return nil
	}
	return &out
}

func canonicalClaudeUsage(u claudeUsage) int64 {
	return u.InputTokens + u.OutputTokens + u.CacheReadInputTokens + u.cacheCreationTokens()
}

func (u claudeUsage) cacheCreationTokens() int64 {
	if u.CacheCreationInputTokens > 0 {
		return u.CacheCreationInputTokens
	}
	return u.CacheCreation.Ephemeral5mInputTokens + u.CacheCreation.Ephemeral1hInputTokens
}

// extractUserText returns the user's textual prompt — either the raw
// string when message.content is a string, or the joined text blocks when
// it is an array (tool_result blocks are skipped on purpose).
func extractUserText(msg json.RawMessage) string {
	if len(msg) == 0 {
		return ""
	}
	var m rawMessage
	if err := json.Unmarshal(msg, &m); err != nil {
		return ""
	}
	var asString string
	if err := json.Unmarshal(m.Content, &asString); err == nil {
		return asString
	}
	var blocks []rawContentBlock
	if err := json.Unmarshal(m.Content, &blocks); err == nil {
		var parts []string
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// extractAssistantText returns the joined text from all text blocks in an
// assistant message. Thinking blocks are projected separately by
// extractAssistantThinking as KindThinking turns (excluded from FTS).
func extractAssistantText(msg json.RawMessage) string {
	if len(msg) == 0 {
		return ""
	}
	var m rawMessage
	if err := json.Unmarshal(msg, &m); err != nil {
		return ""
	}
	var blocks []rawContentBlock
	if err := json.Unmarshal(m.Content, &blocks); err != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// extractAssistantThinking returns each non-empty thinking block in an
// assistant message, in source order. Each block becomes its own
// KindThinking turn so the panel can render them as discrete cards.
func extractAssistantThinking(msg json.RawMessage) []string {
	if len(msg) == 0 {
		return nil
	}
	var m rawMessage
	if err := json.Unmarshal(msg, &m); err != nil {
		return nil
	}
	var blocks []rawContentBlock
	if err := json.Unmarshal(m.Content, &blocks); err != nil {
		return nil
	}
	var out []string
	for _, b := range blocks {
		if b.Type == "thinking" && b.Thinking != "" {
			out = append(out, b.Thinking)
		}
	}
	return out
}

func extractModel(msg json.RawMessage) string {
	if len(msg) == 0 {
		return ""
	}
	var m rawMessage
	if err := json.Unmarshal(msg, &m); err != nil {
		return ""
	}
	return m.Model
}

func isSyntheticModel(model string) bool {
	return model == "<synthetic>"
}

func collectToolUses(msg json.RawMessage, counts map[string]int, idToName map[string]string) {
	if len(msg) == 0 {
		return
	}
	var m rawMessage
	if err := json.Unmarshal(msg, &m); err != nil {
		return
	}
	var blocks []rawContentBlock
	if err := json.Unmarshal(m.Content, &blocks); err != nil {
		return
	}
	for _, b := range blocks {
		if b.Type == "tool_use" && b.Name != "" {
			counts[b.Name]++
			if b.ID != "" {
				idToName[b.ID] = b.Name
			}
		}
	}
}

// toolResultEntry pairs a projected tool_result body with the
// originating tool's name (resolved via tool_use_id when possible).
type toolResultEntry struct {
	text     string
	toolName string
}

// extractToolResults projects tool_result blocks from a user message into
// (text, tool_name) tuples. When the tool_use id → name map has no entry,
// toolName is "" and the renderer falls back to a generic label.
func extractToolResults(msg json.RawMessage, idToName map[string]string) []toolResultEntry {
	if len(msg) == 0 {
		return nil
	}
	var m rawMessage
	if err := json.Unmarshal(msg, &m); err != nil {
		return nil
	}
	var blocks []rawContentBlock
	if err := json.Unmarshal(m.Content, &blocks); err != nil {
		return nil
	}
	var out []toolResultEntry
	for _, b := range blocks {
		if b.Type != "tool_result" {
			continue
		}
		text := extractToolResultText(b.Content)
		if text == "" {
			continue
		}
		out = append(out, toolResultEntry{
			text:     text,
			toolName: idToName[b.ToolUseID],
		})
	}
	return out
}

// extractToolResultText decodes a tool_result block's `content`, which
// may be a plain string or an array of {type,text} blocks (image
// blocks are dropped — only searchable text makes it into a Turn).
func extractToolResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
	}
	var blocks []rawContentBlock
	if err := json.Unmarshal(raw, &blocks); err == nil {
		var parts []string
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// setFirstPromptIfHuman delegates to sessiontext.BuildFirstPrompt and
// enforces "first wins" semantics on sess.FirstPrompt.
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
