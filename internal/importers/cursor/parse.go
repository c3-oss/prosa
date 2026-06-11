package cursor

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/internal/sessiontext"
	"github.com/c3-oss/prosa/pkg/session"
)

// cursorMeta is the JSON header stored hex-encoded in `meta.value` at
// key='0'. Cursor writes more fields than we project; the importer keeps
// what the canonical session needs and ignores the rest.
type cursorMeta struct {
	AgentID          string `json:"agentId"`
	LatestRootBlobID string `json:"latestRootBlobId"`
	Name             string `json:"name"`
	Mode             string `json:"mode"`
	CreatedAt        int64  `json:"createdAt"`
	LastUsedModel    string `json:"lastUsedModel"`
	// CurrentPlanUri (optional, observed on newer Cursor stores) is
	// a `file:///…/.cursor/plan-<uuid>.md` URI whose prefix points at
	// the workspace root. parse.go uses it as the highest-confidence
	// signal for Session.ProjectPath.
	CurrentPlanURI string `json:"currentPlanUri"`
}

// blobJSON is the loose shape of message blobs. Many blobs in `blobs.data`
// are protobuf state or binary thumbnails; we only project the rows that
// parse as JSON AND carry a string `role`.
type blobJSON struct {
	Role    string          `json:"role"`
	ID      string          `json:"id"`
	Content json.RawMessage `json:"content"`
}

type contentItem struct {
	Type     string `json:"type"`
	Text     string `json:"text"`
	ToolName string `json:"toolName"`
}

// peekSessionID opens the store.db read-only and resolves the canonical
// session id: meta.agentId if present, otherwise the parent directory
// name (Cursor's <agent-id> path segment).
func peekSessionID(path string) (string, error) {
	meta, err := readMeta(path)
	if err == nil && meta.AgentID != "" {
		return meta.AgentID, nil
	}
	return filepath.Base(filepath.Dir(path)), nil
}

// readMeta opens the store.db read-only, decodes the hex-encoded meta row
// at key='0', and returns the parsed cursorMeta. Missing tables / missing
// rows return the zero value with no error (some Cursor stores are empty
// shells until a chat starts).
func readMeta(path string) (cursorMeta, error) {
	db, err := importerutil.OpenSQLiteReadOnly(path)
	if err != nil {
		return cursorMeta{}, err
	}
	defer func() { _ = db.Close() }()

	var hexVal string
	err = db.QueryRow(`SELECT value FROM meta WHERE key='0'`).Scan(&hexVal)
	if errors.Is(err, sql.ErrNoRows) || isMissingTable(err) {
		return cursorMeta{}, nil
	}
	if err != nil {
		return cursorMeta{}, err
	}
	raw, err := hex.DecodeString(hexVal)
	if err != nil {
		// Some legacy stores wrote `value` as plain JSON instead of hex.
		var m cursorMeta
		if json.Unmarshal([]byte(hexVal), &m) == nil {
			return m, nil
		}
		return cursorMeta{}, fmt.Errorf("decode meta hex: %w", err)
	}
	var m cursorMeta
	if err := json.Unmarshal(raw, &m); err != nil {
		return cursorMeta{}, fmt.Errorf("parse meta json: %w", err)
	}
	return m, nil
}

// parseSession reads meta + all blobs and projects them into the canonical
// session.Session / Turn / ToolUsage structs.
//
// Workspace path is resolved in three tiers, highest confidence first:
//
//  1. meta.currentPlanUri — when present, `file://…/.cursor/plan-…`
//     gives the workspace root directly.
//  2. Any absolute path scanned out of a blob whose md5 matches the
//     <workspaceHash> directory segment of the store.db path. Cursor
//     stores chats under `~/.cursor/chats/md5(workspacePath)/…`, so
//     the hash inverts cleanly when a blob carries the original path.
//  3. The `<user_info>` system-injected blob's `Workspace Path:`
//     literal — used as a last-resort fallback before leaving the
//     field nil.
//
// The returned UsageState is always UsageStateUnknown: Cursor's store.db
// never records token counts by design (Cursor bills via subscription).
func parseSession(ctx context.Context, path string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error) {
	meta, err := readMeta(path)
	if err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, fmt.Errorf("read meta: %w", err)
	}

	db, err := importerutil.OpenSQLiteReadOnly(path)
	if err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, err
	}
	defer func() { _ = db.Close() }()

	var (
		turns        []session.Turn
		toolCounts   = map[string]int{}
		firstPrompt  string
		userInfoText string
		pathCandPool = map[string]struct{}{}
		maxTSms      int64
	)

	startedAt := time.Time{}
	if meta.CreatedAt > 0 {
		startedAt = time.UnixMilli(meta.CreatedAt).UTC()
		maxTSms = meta.CreatedAt
	}

	rows, err := db.QueryContext(ctx, `SELECT id, data FROM blobs ORDER BY rowid`)
	if err != nil && !isMissingTable(err) {
		return session.Session{}, nil, nil, session.UsageStateUnknown, fmt.Errorf("query blobs: %w", err)
	}
	if rows != nil {
		defer func() { _ = rows.Close() }()

		for rows.Next() {
			if err := ctx.Err(); err != nil {
				return session.Session{}, nil, nil, session.UsageStateUnknown, err
			}
			var (
				id   string
				data []byte
			)
			if err := rows.Scan(&id, &data); err != nil {
				return session.Session{}, nil, nil, session.UsageStateUnknown, fmt.Errorf("scan blob: %w", err)
			}
			_ = id
			if len(data) == 0 {
				continue
			}
			if data[0] == '{' || data[0] == '[' {
				var b blobJSON
				if jerr := json.Unmarshal(data, &b); jerr != nil || b.Role == "" {
					continue
				}
				text, tools := extractContent(b.Content)
				for _, t := range tools {
					toolCounts[t]++
				}
				if text == "" {
					continue
				}
				if userInfoText == "" && strings.Contains(text, "Workspace Path:") {
					userInfoText = text
				}
				switch b.Role {
				case "user":
					query, hasQuery := extractUserPromptText(text)
					if firstPrompt == "" && hasQuery {
						if p, ok := sessiontext.BuildFirstPrompt(query, importerutil.FirstPromptMaxRunes); ok {
							firstPrompt = p
						}
					}
					payload := text
					if hasQuery && query != "" {
						payload = query
					}
					turns = append(turns, session.Turn{Role: "user", Content: payload, Timestamp: startedAt})
				case "assistant":
					turns = append(turns, session.Turn{Role: "assistant", Content: text, Timestamp: startedAt})
				}
				continue
			}
			// Protobuf state-node blob: scan for embedded timestamps and
			// file paths the message touched.
			scanBlob(
				data,
				func(ts int64) {
					if ts > maxTSms {
						maxTSms = ts
					}
				},
				func(p string) { pathCandPool[p] = struct{}{} },
			)
		}
		if err := rows.Err(); err != nil {
			return session.Session{}, nil, nil, session.UsageStateUnknown, fmt.Errorf("iterate blobs: %w", err)
		}
	}

	var sess session.Session
	sess.ID = meta.AgentID
	if meta.LastUsedModel != "" {
		m := meta.LastUsedModel
		sess.Model = &m
	}
	sess.StartedAt = startedAt
	if maxTSms > 0 {
		sess.LastActivityAt = time.UnixMilli(maxTSms).UTC()
	} else {
		sess.LastActivityAt = startedAt
	}
	if firstPrompt != "" {
		p := firstPrompt
		sess.FirstPrompt = &p
	}

	if proj := resolveProjectPath(path, meta.CurrentPlanURI, pathCandPool, userInfoText); proj != "" {
		sess.ProjectPath = &proj
	}

	tools := make([]session.ToolUsage, 0, len(toolCounts))
	for name, count := range toolCounts {
		tools = append(tools, session.ToolUsage{Name: name, Count: count})
	}
	return sess, turns, tools, session.UsageStateUnknown, nil
}

// resolveProjectPath threads the three workspace-path signals (plan
// URI, md5-verified blob paths, user_info Workspace Path: literal) and
// returns the highest-confidence candidate.
func resolveProjectPath(storePath, planURI string, candidates map[string]struct{}, userInfoText string) string {
	if planURI != "" {
		if p := workspacePathFromPlanURI(planURI); p != "" {
			return p
		}
	}
	if hash := workspaceHashFromStorePath(storePath); hash != "" && len(candidates) > 0 {
		list := make([]string, 0, len(candidates))
		for p := range candidates {
			list = append(list, p)
		}
		if p := resolveWorkspacePath(hash, list); p != "" {
			return p
		}
	}
	if userInfoText != "" {
		if p := workspacePathFromUserInfo(userInfoText); p != "" {
			return p
		}
	}
	return ""
}

// extractContent returns the joined text of all `text` content items plus
// the names of every `tool-call` content item. Cursor's content can be a
// plain string or an array of typed items.
func extractContent(content json.RawMessage) (string, []string) {
	if len(content) == 0 {
		return "", nil
	}
	var asString string
	if err := json.Unmarshal(content, &asString); err == nil {
		return asString, nil
	}
	var items []contentItem
	if err := json.Unmarshal(content, &items); err != nil {
		return "", nil
	}
	var parts []string
	var tools []string
	for _, it := range items {
		switch it.Type {
		case "text":
			if it.Text != "" {
				parts = append(parts, it.Text)
			}
		case "tool-call":
			if it.ToolName != "" {
				tools = append(tools, it.ToolName)
			}
		}
	}
	return strings.Join(parts, "\n"), tools
}

// userQueryTagOpen / Close bracket the actual user prompt inside a
// cursor "user" blob that also carries `<timestamp>` and other
// wrappers. Stable across Cursor 3.x.
const (
	userQueryTagOpen  = "<user_query>"
	userQueryTagClose = "</user_query>"
)

// systemWrapperTags are leading XML-style tags that mark a cursor
// "user" blob as system-injected scaffolding rather than a
// human-authored prompt. The first-prompt heuristic skips any blob
// whose content starts with one of these.
var systemWrapperTags = []string{
	"<user_info>",
	"<system_reminder>",
	"<attached_files>",
}

// extractUserPromptText pulls the human-authored prompt out of a cursor user
// blob, stripping Cursor 3.x scaffolding wrappers. Returns ("", false) when
// the blob is system-injected scaffolding the caller should skip entirely.
func extractUserPromptText(content string) (string, bool) {
	if open := strings.Index(content, userQueryTagOpen); open >= 0 {
		rest := content[open+len(userQueryTagOpen):]
		if end := strings.Index(rest, userQueryTagClose); end >= 0 {
			return strings.TrimSpace(rest[:end]), true
		}
		return strings.TrimSpace(rest), true
	}
	trimmed := strings.TrimLeft(content, " \t\r\n")
	for _, tag := range systemWrapperTags {
		if strings.HasPrefix(trimmed, tag) {
			return "", false
		}
	}
	return content, true
}

// isMissingTable reports whether err is a SQLite "no such table: <name>"
// error. Cursor creates `store.db` on the first chat write but does not
// run `CREATE TABLE meta`/`CREATE TABLE blobs` until the user actually
// sends a message, so the importer can race with that bootstrap and see
// an empty shell. modernc.org/sqlite surfaces this as a SQL logic error
// with code 1 (SQLITE_ERROR) and no typed sentinel; the message text has
// been stable across SQLite versions for two decades, so substring match
// is the practical detection.
func isMissingTable(err error) bool {
	return err != nil && strings.Contains(err.Error(), "no such table")
}
