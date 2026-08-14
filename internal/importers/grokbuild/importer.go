// Package grokbuild implements the prosa importer for Grok Build (xAI's
// CLI agent, binary `grok`) sessions stored under
// ~/.grok/sessions/<percent-encoded-cwd>/<uuidv7>/. Each session is a
// directory: summary.json (metadata, the walk anchor), chat_history.jsonl
// (untimestamped chat records), and updates.jsonl (usage/cost ledger in
// turn_completed records). The raw artifact is a canonical projection of
// those files — see docs/sources/grok-build.md and
// docs/architecture/importers.md for the multi-file projection contract.
package grokbuild

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"

	"github.com/c3-oss/prosa/internal/device"
	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/internal/importers/importpolicy"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/projectid"
	"github.com/c3-oss/prosa/internal/sessionkind"
	"github.com/c3-oss/prosa/pkg/importer"
	"github.com/c3-oss/prosa/pkg/session"
)

// Name is the agent identifier used in session rows and CLI output.
const Name = "grok-build"

// Importer satisfies importer.Importer for Grok Build.
type Importer struct{}

// New returns a zero-state importer; the type has no configuration.
func New() *Importer { return &Importer{} }

func (i *Importer) Name() string { return Name }

func (i *Importer) DefaultRoots() []string {
	home, err := paths.UserHome()
	if err != nil {
		return nil
	}
	return i.RootsUnder(filepath.Join(home, ".grok"))
}

func (i *Importer) RootsUnder(base string) []string {
	return []string{filepath.Join(base, "sessions")}
}

// projectedLine wraps a source file that is not chat/updates content in
// a typed envelope so the raw projection is self-describing.
type projectedLine struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// Import projects one session directory, anchored on its summary.json.
// The raw artifact is an in-memory projection (summary, optional
// subagent meta, chat lines, turn_completed lines) hashed before any
// write — the same hash serves as dedup key, RawHash, and sync hash, so
// new chat lines, new usage records, or summary drift all trigger
// re-import.
func (i *Importer) Import(ctx context.Context, summaryPath string, sink importer.Sink, opts importer.ImportOptions) (importer.ImportResult, error) {
	dir := filepath.Dir(summaryPath)

	summaryRaw, err := os.ReadFile(summaryPath)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("read summary %s: %w", summaryPath, err)
	}
	var sum summaryFile
	if err := json.Unmarshal(summaryRaw, &sum); err != nil {
		return importer.ImportResult{}, fmt.Errorf("decode summary %s: %w", summaryPath, err)
	}

	id := sum.Info.ID
	if id == "" {
		id = filepath.Base(dir)
	} else if id != filepath.Base(dir) {
		slog.Warn("grok-build: summary id differs from directory name",
			"summary_id", id, "dir", filepath.Base(dir))
	}
	if err := session.ValidateID(id); err != nil {
		return importer.ImportResult{}, fmt.Errorf("session id %s: %w", summaryPath, err)
	}

	var (
		parentID      string
		parentMetaRaw json.RawMessage
	)
	if sum.SessionKind == "subagent" {
		parentID, parentMetaRaw = resolveParentMeta(dir, id)
	}

	chatLines, err := readJSONLines(filepath.Join(dir, "chat_history.jsonl"))
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("read chat history %s: %w", dir, err)
	}
	updateLines, err := readJSONLines(filepath.Join(dir, "updates.jsonl"))
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("read updates %s: %w", dir, err)
	}
	turnLines, usageRecs := filterTurnCompleted(updateLines)

	lines, err := projectionLines(summaryRaw, parentMetaRaw, chatLines, turnLines)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("project raw %s: %w", dir, err)
	}
	hash, size := importerutil.HashProjectedLines(lines)

	if !opts.Overwrite {
		if prev, found, err := sink.LastHash(ctx, id); err == nil && found && prev == hash {
			return importer.ImportResult{
				SessionID: id,
				RawHash:   hash,
				RawSize:   size,
				Skipped:   true,
			}, nil
		}
		if res, ok, err := importpolicy.PreviouslySkippedNoUsage(ctx, sink, id, hash, size); err != nil {
			return importer.ImportResult{}, fmt.Errorf("read import skip %s: %w", id, err)
		} else if ok {
			return res, nil
		}
	}

	sess := projectSummary(sum, dir)
	sess.ID = id
	if parentID != "" {
		sess.ParentSessionID = &parentID
	}
	turns, toolCounts, firstPrompt := projectChat(chatLines, sess.StartedAt)
	sess.FirstPrompt = firstPrompt
	usage, seenUsage := sumUsage(usageRecs)
	sess.Usage = usage
	state := session.ClassifyUsage(seenUsage, sess.Usage)
	if importpolicy.ClassifyForImport(state) == importpolicy.DecisionSkipNoUsage {
		return importpolicy.RecordNoUsageSkip(ctx, sink, id, hash, size)
	}

	rawPath, rawHash, rawSize, err := importerutil.PreserveProjectedJSONL(Name, id, sess.StartedAt, lines)
	if err != nil {
		return importer.ImportResult{}, fmt.Errorf("preserve projected raw %s: %w", id, err)
	}
	sess.RawPath = rawPath
	sess.RawHash = rawHash
	sess.RawSize = rawSize

	sess.Agent = Name
	sess.DeviceID = device.IDOnce()
	sess.Profile = session.ProfileOrDefault(opts.Profile)
	projectid.Apply(&sess)

	tools := make([]session.ToolUsage, 0, len(toolCounts))
	for name, count := range toolCounts {
		tools = append(tools, session.ToolUsage{Name: name, Count: count})
	}
	sess.Kinds = sessionkind.Classify(turns, importerutil.ToolNames(tools))

	if err := sink.WriteSession(ctx, sess, tools, turns, hash); err != nil {
		return importer.ImportResult{}, fmt.Errorf("write session %s: %w", id, err)
	}

	return importer.ImportResult{
		SessionID: id,
		RawPath:   rawPath,
		RawHash:   rawHash,
		RawSize:   rawSize,
		Skipped:   false,
	}, nil
}

// projectSummary maps summary.json onto the canonical session shell.
func projectSummary(sum summaryFile, dir string) session.Session {
	var sess session.Session

	cwd := sum.Info.CWD
	if cwd == "" {
		if dec, err := url.PathUnescape(filepath.Base(filepath.Dir(dir))); err == nil {
			cwd = dec
		}
	}
	if cwd != "" {
		sess.ProjectPath = &cwd
	}

	if t, ok := importerutil.ParseRFC3339(sum.CreatedAt); ok {
		sess.StartedAt = t
	}
	if t, ok := importerutil.ParseRFC3339(sum.LastActiveAt); ok {
		sess.LastActivityAt = t
	} else if t, ok := importerutil.ParseRFC3339(sum.UpdatedAt); ok {
		sess.LastActivityAt = t
	} else {
		sess.LastActivityAt = sess.StartedAt
	}

	if sum.CurrentModelID != "" {
		m := sum.CurrentModelID
		sess.Model = &m
	}
	if len(sum.GitRemotes) > 0 && sum.GitRemotes[0] != "" {
		r := sum.GitRemotes[0]
		sess.ProjectRemote = &r
	}
	return sess
}

// projectionLines assembles the raw artifact: the compacted summary,
// the compacted subagent meta when present, every chat line verbatim,
// then every turn_completed update line verbatim.
func projectionLines(summaryRaw []byte, parentMetaRaw json.RawMessage, chatLines, turnLines []json.RawMessage) ([]json.RawMessage, error) {
	lines := make([]json.RawMessage, 0, 2+len(chatLines)+len(turnLines))

	summaryLine, err := marshalProjectedLine("session_summary", summaryRaw)
	if err != nil {
		return nil, err
	}
	lines = append(lines, summaryLine)

	if len(parentMetaRaw) > 0 {
		metaLine, err := marshalProjectedLine("subagent_meta", parentMetaRaw)
		if err != nil {
			return nil, err
		}
		lines = append(lines, metaLine)
	}

	lines = append(lines, chatLines...)
	lines = append(lines, turnLines...)
	return lines, nil
}

func marshalProjectedLine(typ string, data []byte) (json.RawMessage, error) {
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		return nil, fmt.Errorf("compact %s: %w", typ, err)
	}
	line, err := json.Marshal(projectedLine{Type: typ, Data: compact.Bytes()})
	if err != nil {
		return nil, fmt.Errorf("marshal %s line: %w", typ, err)
	}
	return line, nil
}

// resolveParentMeta finds the subagents/<childID>/meta.json a parent
// session keeps for a spawned child — first among sibling sessions of
// the same project directory, then across the whole sessions root — and
// returns the parent session id plus the raw meta bytes for the
// projection. Resolution happens before hashing so a late-appearing or
// changed meta.json changes the hash and triggers re-import.
func resolveParentMeta(dir, childID string) (string, json.RawMessage) {
	projectDir := filepath.Dir(dir)
	patterns := []string{
		filepath.Join(projectDir, "*", "subagents", childID, "meta.json"),
		filepath.Join(filepath.Dir(projectDir), "*", "*", "subagents", childID, "meta.json"),
	}
	for _, pattern := range patterns {
		matches, err := filepath.Glob(pattern)
		if err != nil || len(matches) == 0 {
			continue
		}
		raw, err := os.ReadFile(matches[0])
		if err != nil {
			continue
		}
		var meta subagentMeta
		if err := json.Unmarshal(raw, &meta); err != nil || meta.ParentSessionID == "" {
			continue
		}
		return meta.ParentSessionID, raw
	}
	slog.Warn("grok-build: subagent session has no resolvable parent meta", "session", childID)
	return "", nil
}
