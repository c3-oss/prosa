package grokbuild

import (
	"bufio"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/internal/sessiontext"
	"github.com/c3-oss/prosa/pkg/session"
)

// summaryFile is the subset of summary.json the projection needs.
type summaryFile struct {
	Info struct {
		ID  string `json:"id"`
		CWD string `json:"cwd"`
	} `json:"info"`
	CreatedAt      string   `json:"created_at"`
	UpdatedAt      string   `json:"updated_at"`
	LastActiveAt   string   `json:"last_active_at"`
	CurrentModelID string   `json:"current_model_id"`
	GitRemotes     []string `json:"git_remotes"`
	SessionKind    string   `json:"session_kind"`
}

// chatRecord is the loose shape of one chat_history.jsonl line. The
// type set is open — unknown types are tolerated (warn+skip). Content
// shape depends on type: user carries `[{type:"text",text}]` blocks,
// assistant and tool_result carry plain strings.
type chatRecord struct {
	Type            string          `json:"type"`
	Content         json.RawMessage `json:"content"`
	ToolCalls       []chatToolCall  `json:"tool_calls"`
	ToolCallID      string          `json:"tool_call_id"`
	Summary         json.RawMessage `json:"summary"`
	PromptIndex     *int            `json:"prompt_index"`
	SyntheticReason string          `json:"synthetic_reason"`
	Kind            *backendKind    `json:"kind"`
}

// chatToolCall is one assistant tool invocation; arguments (a
// JSON-encoded string) are not needed by the projection.
type chatToolCall struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// backendKind describes a server-side tool call (e.g. web_search).
type backendKind struct {
	ToolType string `json:"tool_type"`
}

// updateRecord is one updates.jsonl line; only
// `params.update.sessionUpdate == "turn_completed"` lines matter.
type updateRecord struct {
	Params struct {
		Update struct {
			SessionUpdate string     `json:"sessionUpdate"`
			PromptID      string     `json:"prompt_id"`
			Usage         *usageJSON `json:"usage"`
		} `json:"update"`
	} `json:"params"`
}

type usageJSON struct {
	InputTokens         int64 `json:"inputTokens"`
	OutputTokens        int64 `json:"outputTokens"`
	TotalTokens         int64 `json:"totalTokens"`
	CachedReadTokens    int64 `json:"cachedReadTokens"`
	CacheCreationTokens int64 `json:"cacheCreationTokens"`
}

// subagentMeta is the subset of a subagents/<child>/meta.json the
// parent edge needs.
type subagentMeta struct {
	ParentSessionID string `json:"parent_session_id"`
}

// subagentCompletedPrefix marks turn_completed records that aggregate a
// child session's model calls into the parent ledger. Excluded from
// usage sums — the child's own ledger already carries them.
const subagentCompletedPrefix = "subagent-completed-"

// readJSONLines returns every syntactically valid JSON line of a JSONL
// file. Malformed or torn lines are warned and dropped so they never
// reach the raw projection (a torn tail would change on the next append
// anyway). A missing file returns nil with no error.
func readJSONLines(path string, log *slog.Logger) ([]json.RawMessage, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, importerutil.ScanBufferInitial), importerutil.ScanBufferMax)

	var out []json.RawMessage
	line := 0
	for sc.Scan() {
		line++
		b := sc.Bytes()
		if len(b) == 0 {
			continue
		}
		if !json.Valid(b) {
			log.Warn("grok-build: malformed JSONL line dropped", "path", path, "line", line)
			continue
		}
		out = append(out, json.RawMessage(append([]byte(nil), b...)))
	}
	if err := sc.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			log.Warn("grok-build: JSONL line exceeded 16 MiB scan buffer; partial file",
				"path", path, "line", line+1)
			return out, nil
		}
		return nil, err
	}
	return out, nil
}

// filterTurnCompleted keeps the updates.jsonl lines whose
// sessionUpdate is "turn_completed", returning the raw lines (for the
// projection) and their decoded usage records (for the sums).
func filterTurnCompleted(lines []json.RawMessage) ([]json.RawMessage, []updateRecord) {
	var (
		kept []json.RawMessage
		recs []updateRecord
	)
	for _, line := range lines {
		var u updateRecord
		if err := json.Unmarshal(line, &u); err != nil {
			continue
		}
		if u.Params.Update.SessionUpdate != "turn_completed" {
			continue
		}
		kept = append(kept, line)
		recs = append(recs, u)
	}
	return kept, recs
}

// sumUsage adds up the per-prompt turn_completed deltas, excluding
// subagent-completed-* aggregates (their tokens live in the child
// session's own ledger). seenUsage is true when at least one
// non-excluded record was parsed — a session whose only record is a
// subagent aggregate classifies Unknown, not ExplicitZero.
func sumUsage(recs []updateRecord) (usage *session.TokenUsage, seenUsage bool) {
	var sum session.TokenUsage
	for _, r := range recs {
		if strings.HasPrefix(r.Params.Update.PromptID, subagentCompletedPrefix) {
			continue
		}
		seenUsage = true
		u := r.Params.Update.Usage
		if u == nil {
			continue
		}
		total := u.TotalTokens
		if total == 0 {
			total = u.InputTokens + u.OutputTokens
		}
		sum.TotalTokens += total
		sum.InputTokens += u.InputTokens
		sum.OutputTokens += u.OutputTokens
		sum.CachedTokens += u.CachedReadTokens
		sum.CacheReadTokens += u.CachedReadTokens
		sum.CacheCreationTokens += u.CacheCreationTokens
	}
	if !seenUsage || !session.HasTokenUsage(&sum) {
		return nil, seenUsage
	}
	return &sum, seenUsage
}

// projectChat walks the chat lines once and returns the turns, tool
// counters, and the first human prompt. Chat records carry no
// timestamps, so every turn is stamped with the session's created_at —
// the store orders by (ts, id) so insertion order is preserved.
func projectChat(lines []json.RawMessage, createdAt time.Time, log *slog.Logger) (turns []session.Turn, toolCounts map[string]int, firstPrompt *string) {
	toolCounts = map[string]int{}
	callIDToName := map[string]string{}

	for n, line := range lines {
		var r chatRecord
		if err := json.Unmarshal(line, &r); err != nil {
			log.Warn("grok-build: undecodable chat record skipped", "line", n+1, "err", err)
			continue
		}
		switch r.Type {
		case "system":
			// Injected scaffold, never a turn.

		case "user":
			// Human turn ⇔ prompt_index present AND synthetic_reason
			// absent; everything else is injected context.
			if r.PromptIndex == nil || r.SyntheticReason != "" {
				continue
			}
			text := unwrapUserQuery(extractUserText(r.Content))
			if text == "" {
				continue
			}
			if firstPrompt == nil {
				if prompt, ok := sessiontext.BuildFirstPrompt(text, importerutil.FirstPromptMaxRunes); ok {
					firstPrompt = &prompt
				}
			}
			turns = append(turns, session.Turn{
				Role: "user", Content: text, Timestamp: createdAt, Kind: session.KindMessage,
			})

		case "assistant":
			// Tool calls are processed unconditionally — most
			// tool-calling assistant records carry empty content.
			for _, tc := range r.ToolCalls {
				if tc.Name == "" {
					continue
				}
				toolCounts[tc.Name]++
				if tc.ID != "" {
					callIDToName[tc.ID] = tc.Name
				}
			}
			if text := extractPlainText(r.Content); text != "" {
				turns = append(turns, session.Turn{
					Role: "assistant", Content: text, Timestamp: createdAt, Kind: session.KindMessage,
				})
			}

		case "reasoning":
			text := extractSummaryText(r.Summary)
			if text == "" {
				continue
			}
			turns = append(turns, session.Turn{
				Role:      "assistant",
				Content:   importerutil.TruncatePreview(text),
				Timestamp: createdAt,
				Kind:      session.KindThinking,
			})

		case "tool_result":
			text := extractPlainText(r.Content)
			if text == "" {
				continue
			}
			turns = append(turns, session.Turn{
				Role:      "tool",
				Content:   importerutil.TruncatePreview(text),
				Timestamp: createdAt,
				Kind:      session.KindToolResult,
				ToolName:  callIDToName[r.ToolCallID],
			})

		case "backend_tool_call":
			if r.Kind != nil && r.Kind.ToolType != "" {
				toolCounts[r.Kind.ToolType]++
			}

		default:
			log.Warn("grok-build: unknown chat record type skipped", "type", r.Type, "line", n+1)
		}
	}
	return turns, toolCounts, firstPrompt
}

// unwrapUserQuery strips the `<user_query>…</user_query>` wrapper Grok
// Build puts around the human prompt. Text without the wrapper (e.g.
// subagent delegation prompts) passes through unchanged.
func unwrapUserQuery(text string) string {
	trimmed := strings.TrimSpace(text)
	const open, closing = "<user_query>", "</user_query>"
	if !strings.HasPrefix(trimmed, open) || !strings.HasSuffix(trimmed, closing) {
		return trimmed
	}
	return strings.TrimSpace(trimmed[len(open) : len(trimmed)-len(closing)])
}

// extractUserText concatenates the text of `{type:"text",text}` blocks.
// A plain string and unknown block types are tolerated.
func extractUserText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
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
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// extractPlainText decodes the assistant / tool_result content, which
// is a plain JSON string in every observed record.
func extractPlainText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
	}
	return ""
}

// extractSummaryText concatenates `{type:"summary_text",text}` blocks
// from a reasoning record's summary, which may be empty.
func extractSummaryText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
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
		if b.Type == "summary_text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}
