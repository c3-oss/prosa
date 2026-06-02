package antigravity

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver, registers "sqlite"

	"github.com/c3-oss/prosa/internal/sessiontext"
	"github.com/c3-oss/prosa/pkg/session"
)

const (
	firstPromptMaxRunes = 200

	// step_type values from cortex.proto's CortexStepType enum
	// (extracted from the agy Go binary's embedded FileDescriptorProto).
	// Antigravity inherits the enum unchanged from its parent codebase
	// (Codeium / Windsurf "Cascade"); only the values we route on are
	// listed here. Unobserved values fall through to the best-effort
	// branch in projectSteps.
	stepTypeUserInput       = 14 // CortexStepUserInput
	stepTypePlannerResponse = 15 // CortexStepPlannerResponse — assistant text
	stepTypeCheckpoint      = 23 // CortexStepCheckpoint — turn boundary
)

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

// openReadOnly opens the .db with mode=ro&immutable=1 so reads never
// block antigravity's writer connection in active sessions. Same driver
// name as internal/store/store.go uses ("sqlite" via modernc.org/sqlite).
func openReadOnly(path string) (*sql.DB, error) {
	dsn := "file:" + url.PathEscape(path) + "?mode=ro&immutable=1"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite (ro) %s: %w", path, err)
	}
	return db, nil
}

// peekSessionID opens the DB read-only and reads
// trajectory_meta.cascade_id. Falls back to the filename UUID when the
// row is missing or empty.
func peekSessionID(path string) (string, error) {
	fallback := strings.TrimSuffix(filepath.Base(path), ".db")
	db, err := openReadOnly(path)
	if err != nil {
		return fallback, nil
	}
	defer func() { _ = db.Close() }()

	var cascade string
	err = db.QueryRow(`SELECT cascade_id FROM trajectory_meta LIMIT 1`).Scan(&cascade)
	if err != nil || cascade == "" {
		return fallback, nil
	}
	return cascade, nil
}

// parseSession opens the .db and projects it into the canonical shape.
// Returns UsageStateUnknown when no usage signal is decodable — that
// admits the session without a session_usage row (same posture as
// gemini for transcripts without a tokens block).
func parseSession(ctx context.Context, path string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error) {
	db, err := openReadOnly(path)
	if err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, err
	}
	defer func() { _ = db.Close() }()
	if err := db.PingContext(ctx); err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, fmt.Errorf("ping sqlite (ro): %w", err)
	}

	var sess session.Session
	if err := db.QueryRowContext(ctx, `SELECT cascade_id FROM trajectory_meta LIMIT 1`).Scan(&sess.ID); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return session.Session{}, nil, nil, session.UsageStateUnknown, fmt.Errorf("read trajectory_meta: %w", err)
		}
		sess.ID = strings.TrimSuffix(filepath.Base(path), ".db")
	}
	if sess.ID == "" {
		sess.ID = strings.TrimSuffix(filepath.Base(path), ".db")
	}

	var blob []byte
	if err := db.QueryRowContext(
		ctx,
		`SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1`,
	).Scan(&blob); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return session.Session{}, nil, nil, session.UsageStateUnknown,
			fmt.Errorf("read trajectory_metadata_blob: %w", err)
	}
	if workspace := decodeWorkspacePath(blob); workspace != "" {
		p := workspace
		sess.ProjectPath = &p
	}

	turns, tools, firstTS, lastTS, firstPromptText, usage, seenUsage, err := projectSteps(ctx, db)
	if err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown,
			fmt.Errorf("project steps: %w", err)
	}
	if !firstTS.IsZero() {
		sess.StartedAt = firstTS
	} else if info, statErr := os.Stat(path); statErr == nil {
		sess.StartedAt = info.ModTime().UTC()
	}
	if !lastTS.IsZero() {
		sess.LastActivityAt = lastTS
	} else {
		sess.LastActivityAt = sess.StartedAt
	}
	if firstPromptText != "" {
		if prompt, ok := sessiontext.BuildFirstPrompt(firstPromptText, firstPromptMaxRunes); ok {
			sess.FirstPrompt = &prompt
		}
	}
	if session.HasTokenUsage(usage) {
		sess.Usage = usage
	}

	if model, ok := readGenerationModel(ctx, db); ok {
		m := model
		sess.Model = &m
	}

	state := session.ClassifyUsage(seenUsage, sess.Usage)
	return sess, turns, tools, state, nil
}

// decodeWorkspacePath scans trajectory_metadata_blob.data for the
// first string field that parses as a file:// URL and returns its
// filesystem path. Empty string when no such field exists.
func decodeWorkspacePath(blob []byte) string {
	var workspace string
	scanStrings(blob, func(s string) bool {
		if strings.HasPrefix(s, "file://") {
			workspace = strings.TrimPrefix(s, "file://")
			return false
		}
		return true
	})
	return workspace
}

// projectSteps streams steps in idx order and projects each into a
// turn (when applicable). Tool counts aggregate alongside; timestamps
// derive from the per-step metadata Timestamp #1. Per-step token
// usage decoded out of metadata field 9 is aggregated into the
// returned TokenUsage. Returns sorted tool usage so test assertions
// stay deterministic.
func projectSteps(ctx context.Context, db *sql.DB) (
	turns []session.Turn,
	tools []session.ToolUsage,
	firstTS, lastTS time.Time,
	firstPrompt string,
	usage *session.TokenUsage,
	seenUsage bool,
	err error,
) {
	rows, qerr := db.QueryContext(ctx, `
		SELECT idx, step_type, metadata, step_payload
		FROM steps
		ORDER BY idx ASC
	`)
	if qerr != nil {
		return nil, nil, time.Time{}, time.Time{}, "", nil, false, qerr
	}
	defer func() { _ = rows.Close() }()

	toolCounts := map[string]int{}
	var prevTS time.Time
	var sumInput, sumOutput, sumCacheRead, sumCacheWrite int64
	for rows.Next() {
		if cerr := ctx.Err(); cerr != nil {
			return nil, nil, time.Time{}, time.Time{}, "", nil, false, cerr
		}
		var (
			idx     int
			stepTyp int
			meta    []byte
			payload []byte
		)
		if serr := rows.Scan(&idx, &stepTyp, &meta, &payload); serr != nil {
			return nil, nil, time.Time{}, time.Time{}, "", nil, false, fmt.Errorf("scan step: %w", serr)
		}
		ts, ok := readStepEventTime(meta)
		if !ok {
			ts = prevTS
		}
		if !ts.IsZero() {
			if firstTS.IsZero() || ts.Before(firstTS) {
				firstTS = ts
			}
			if ts.After(lastTS) {
				lastTS = ts
			}
			prevTS = ts
		}

		if u := readStepUsage(meta); u.Present {
			seenUsage = true
			sumInput += u.InputTokens
			sumOutput += u.OutputTokens
			sumCacheRead += u.CacheReadTokens
			sumCacheWrite += u.CacheWriteTokens
		}

		switch stepTyp {
		case stepTypeUserInput:
			if firstPrompt != "" {
				continue
			}
			text, ok := readStepUserPrompt(payload)
			if !ok || text == "" {
				continue
			}
			firstPrompt = text
			turns = append(turns, session.Turn{
				Role:      "user",
				Content:   text,
				Timestamp: ts,
				Kind:      session.KindMessage,
			})

		case stepTypePlannerResponse:
			if text, ok := readPlannerResponseText(payload); ok && text != "" {
				turns = append(turns, session.Turn{
					Role:      "assistant",
					Content:   text,
					Timestamp: ts,
					Kind:      session.KindMessage,
				})
			}

		case stepTypeCheckpoint:
			// Trajectory checkpoint marker; nothing to project.

		default:
			if name, args, ok := scanToolCall(payload); ok && name != "" {
				toolCounts[name]++
				turns = append(turns, session.Turn{
					Role:      "tool",
					Content:   args,
					Timestamp: ts,
					Kind:      session.KindToolResult,
					ToolName:  name,
				})
				continue
			}
			if text, ok := firstLargeString(payload, 16); ok {
				turns = append(turns, session.Turn{
					Role:      "assistant",
					Content:   text,
					Timestamp: ts,
					Kind:      session.KindMessage,
				})
			}
		}
	}
	if rerr := rows.Err(); rerr != nil {
		return nil, nil, time.Time{}, time.Time{}, "", nil, false, rerr
	}

	tools = make([]session.ToolUsage, 0, len(toolCounts))
	for name, count := range toolCounts {
		tools = append(tools, session.ToolUsage{Name: name, Count: count})
	}
	sort.Slice(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })

	if seenUsage {
		// In ModelUsageStats, cache_read_tokens count the portion of
		// the prompt that was served from cache; they are billed at a
		// lower rate but still arrive at the model alongside
		// input_tokens. We surface the full prompt size as
		// InputTokens, with cache_read tracked separately for cost
		// reporting.
		totalInput := sumInput + sumCacheRead
		usage = &session.TokenUsage{
			TotalTokens:         totalInput + sumOutput,
			InputTokens:         totalInput,
			OutputTokens:        sumOutput,
			CachedTokens:        sumCacheRead,
			CacheReadTokens:     sumCacheRead,
			CacheCreationTokens: sumCacheWrite,
		}
	}

	return turns, tools, firstTS, lastTS, firstPrompt, usage, seenUsage, nil
}

// readGenerationModel returns the canonical model identifier for the
// trajectory. Tries executor_metadata first (carries the full model
// name, e.g. "gemini-3.5-flash-low") and falls back to gen_metadata
// (16-char truncated alias, e.g. "gemini-3-flash-a").
func readGenerationModel(ctx context.Context, db *sql.DB) (string, bool) {
	var execBlob []byte
	if err := db.QueryRowContext(
		ctx,
		`SELECT data FROM executor_metadata ORDER BY idx ASC LIMIT 1`,
	).Scan(&execBlob); err == nil {
		if name, ok := readExecutorModelName(execBlob); ok {
			return name, true
		}
	}

	rows, err := db.QueryContext(ctx, `SELECT data FROM gen_metadata ORDER BY idx ASC`)
	if err != nil {
		return "", false
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		if cerr := ctx.Err(); cerr != nil {
			return "", false
		}
		var data []byte
		if scanErr := rows.Scan(&data); scanErr != nil {
			return "", false
		}
		if info := readGenerationInfo(data); info.ModelName != "" {
			return info.ModelName, true
		}
	}
	return "", false
}
