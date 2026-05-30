package claudecode

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
	"strings"
	"time"

	"github.com/c3-oss/prosa/pkg/session"
)

const (
	// scanBufferMax bounds the largest JSONL line bufio.Scanner accepts.
	// Real Claude Code sessions carry tool_result bodies over 4 MiB; we
	// raise the ceiling to 16 MiB. Lines past this threshold log a warning
	// and the importer continues with partial session data — most
	// metadata-bearing records (sessionId, cwd, first user prompt, model)
	// arrive in the first few lines of the file.
	scanBufferMax = 16 << 20

	// scanBufferInitial is the starting buffer size; bufio.Scanner grows
	// as needed up to scanBufferMax.
	scanBufferInitial = 64 << 10

	// firstPromptMaxRunes is the truncation limit for the first user
	// prompt projected onto Session.FirstPrompt; balances timeline
	// readability against information density.
	firstPromptMaxRunes = 200
)

type rawRecord struct {
	Type        string          `json:"type"`
	SessionID   string          `json:"sessionId"`
	Timestamp   string          `json:"timestamp"`
	CWD         string          `json:"cwd"`
	IsSidechain bool            `json:"isSidechain"`
	IsMeta      bool            `json:"isMeta"`
	Message     json.RawMessage `json:"message"`
}

type rawMessage struct {
	Role    string          `json:"role"`
	Model   string          `json:"model"`
	Content json.RawMessage `json:"content"`
}

type rawContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
	Name string `json:"name"`
}

func hashAndSize(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()

	h := sha256.New()
	size, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), size, nil
}

// peekSessionID reads only as many lines as needed to find the first
// sessionId field, then returns. Falls back to the filename (sans .jsonl)
// if no record carries one.
func peekSessionID(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, scanBufferInitial), scanBufferMax)
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

// parseSession streams the JSONL once and returns the projected metadata.
// Hash + size are NOT computed here — Import() does that separately so
// peek and full parse are both cheap on warm runs.
func parseSession(ctx context.Context, path string) (session.Session, []session.Turn, []session.ToolUsage, error) {
	f, err := os.Open(path)
	if err != nil {
		return session.Session{}, nil, nil, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, scanBufferInitial), scanBufferMax)

	var (
		sess           session.Session
		turns          []session.Turn
		toolCounts     = map[string]int{}
		sessIDSet      bool
		cwdSet         bool
		modelSet       bool
		firstPromptSet bool
		line           int
	)

	for sc.Scan() {
		line++
		if err := ctx.Err(); err != nil {
			return session.Session{}, nil, nil, err
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
			if t, ok := parseTimestamp(r.Timestamp); ok {
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
			content := extractUserText(r.Message)
			if content != "" {
				if !firstPromptSet {
					// Slash-command and tool-result payloads can carry
					// embedded newlines; collapse whitespace so the
					// timeline cell stays single-line. FTS-bound `turns`
					// keep the original content unchanged.
					p := truncRunes(strings.Join(strings.Fields(content), " "), firstPromptMaxRunes)
					sess.FirstPrompt = &p
					firstPromptSet = true
				}
				ts, _ := parseTimestamp(r.Timestamp)
				turns = append(turns, session.Turn{
					Role:      "user",
					Content:   content,
					Timestamp: ts,
				})
			}

		case "assistant":
			text := extractAssistantText(r.Message)
			if text != "" {
				ts, _ := parseTimestamp(r.Timestamp)
				turns = append(turns, session.Turn{
					Role:      "assistant",
					Content:   text,
					Timestamp: ts,
				})
			}
			if !modelSet {
				if m := extractModel(r.Message); m != "" {
					mm := m
					sess.Model = &mm
					modelSet = true
				}
			}
			collectToolUses(r.Message, toolCounts)
		}
	}

	if err := sc.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			slog.Warn("claude-code: JSONL line exceeded 16 MiB scan buffer; partial session",
				"path", path, "line", line+1)
		} else {
			return session.Session{}, nil, nil, fmt.Errorf("scan %s: %w", path, err)
		}
	}

	tools := make([]session.ToolUsage, 0, len(toolCounts))
	for name, count := range toolCounts {
		tools = append(tools, session.ToolUsage{Name: name, Count: count})
	}
	return sess, turns, tools, nil
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
// assistant message. tool_use, tool_result, and thinking blocks are
// intentionally excluded — they remain reachable via the preserved raw
// JSONL but do not pollute the FTS signal.
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

func collectToolUses(msg json.RawMessage, counts map[string]int) {
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
		}
	}
}

func truncRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + "…"
}
