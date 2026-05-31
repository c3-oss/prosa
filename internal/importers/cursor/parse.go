package cursor

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite" // sqlite driver registered as "sqlite"

	"github.com/c3-oss/prosa/internal/sessiontext"
	"github.com/c3-oss/prosa/pkg/session"
)

const firstPromptMaxRunes = 200

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
	db, err := openReadOnly(path)
	if err != nil {
		return cursorMeta{}, err
	}
	defer func() { _ = db.Close() }()

	var hexVal string
	err = db.QueryRow(`SELECT value FROM meta WHERE key='0'`).Scan(&hexVal)
	if err == sql.ErrNoRows {
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
// session.Session / Turn / ToolUsage structs. Cursor blobs do not carry
// per-message timestamps, so every turn inherits the session's createdAt;
// LastActivityAt mirrors StartedAt for the same reason. Future cuts can
// pull timestamps from blob payloads when Cursor adds them.
func parseSession(ctx context.Context, path string) (session.Session, []session.Turn, []session.ToolUsage, error) {
	meta, err := readMeta(path)
	if err != nil {
		return session.Session{}, nil, nil, fmt.Errorf("read meta: %w", err)
	}

	db, err := openReadOnly(path)
	if err != nil {
		return session.Session{}, nil, nil, err
	}
	defer func() { _ = db.Close() }()

	rows, err := db.QueryContext(ctx, `SELECT id, data FROM blobs ORDER BY rowid`)
	if err != nil {
		return session.Session{}, nil, nil, fmt.Errorf("query blobs: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var (
		turns       []session.Turn
		toolCounts  = map[string]int{}
		firstPrompt string
	)

	ts := time.Time{}
	if meta.CreatedAt > 0 {
		ts = time.UnixMilli(meta.CreatedAt).UTC()
	}

	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return session.Session{}, nil, nil, err
		}
		var (
			id   string
			data []byte
		)
		if err := rows.Scan(&id, &data); err != nil {
			return session.Session{}, nil, nil, fmt.Errorf("scan blob: %w", err)
		}
		_ = id
		if len(data) == 0 || (data[0] != '{' && data[0] != '[') {
			continue
		}
		var b blobJSON
		if err := json.Unmarshal(data, &b); err != nil {
			continue
		}
		if b.Role == "" {
			continue
		}

		text, tools := extractContent(b.Content)
		for _, t := range tools {
			toolCounts[t]++
		}
		if text == "" {
			continue
		}
		switch b.Role {
		case "user":
			if firstPrompt == "" {
				if p, ok := sessiontext.BuildFirstPrompt(text, firstPromptMaxRunes); ok {
					firstPrompt = p
				}
			}
			turns = append(turns, session.Turn{Role: "user", Content: text, Timestamp: ts})
		case "assistant":
			turns = append(turns, session.Turn{Role: "assistant", Content: text, Timestamp: ts})
		}
	}
	if err := rows.Err(); err != nil {
		return session.Session{}, nil, nil, fmt.Errorf("iterate blobs: %w", err)
	}

	var sess session.Session
	sess.ID = meta.AgentID
	if meta.LastUsedModel != "" {
		m := meta.LastUsedModel
		sess.Model = &m
	}
	sess.StartedAt = ts
	sess.LastActivityAt = ts
	if firstPrompt != "" {
		p := firstPrompt
		sess.FirstPrompt = &p
	}

	tools := make([]session.ToolUsage, 0, len(toolCounts))
	for name, count := range toolCounts {
		tools = append(tools, session.ToolUsage{Name: name, Count: count})
	}
	return sess, turns, tools, nil
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

// openReadOnly opens the SQLite file with `mode=ro&immutable=1`. Immutable
// tells modernc.org/sqlite to skip WAL/SHM handling — required because
// Cursor stores often ship without companion files in the legacy bundle.
func openReadOnly(path string) (*sql.DB, error) {
	dsn := "file:" + url.PathEscape(path) + "?mode=ro&immutable=1"
	return sql.Open("sqlite", dsn)
}
