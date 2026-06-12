package claudecode

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// uuidFileRE matches the UUID-shaped basename Claude Code uses for main
// session JSONL files (e.g. "01234567-89ab-4cde-9012-3456789abcde.jsonl").
// The regex is intentionally tolerant on the version nibble (could be any
// hex) because we don't want to depend on Claude Code locking UUIDv4.
var uuidFileRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$`)

// subagentFileRE matches the basename Claude Code uses for subagent
// JSONLs inside a `<parent-uuid>/subagents/` directory. Current CLIs
// name them `agent-<hex-id>.jsonl` (observed: 17 hex chars); older
// builds used a full dashed UUID. Parent UUID is recovered from the
// directory two levels up at parse time.
var subagentFileRE = regexp.MustCompile(`^agent-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,32})\.jsonl$`)

// Walk discovers session JSONL files under root, both top-level
// sessions and the subagent files Claude Code stores under
// `<parent-uuid>/subagents/agent-<uuid>.jsonl`. It still skips:
//   - any directory named `memory` or `tool-results` (no transcripts)
//   - files whose basename does not match the UUID-jsonl pattern at
//     the top level (excludes sessions-index.json, hand-edited *.jsonl)
//   - subagent files whose basename does not match the agent-UUID
//     pattern (defensive against unknown layouts)
//
// A missing root returns an empty slice with no error — typical for
// machines that never installed Claude Code.
func (i *Importer) Walk(ctx context.Context, root string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if d.IsDir() {
			switch d.Name() {
			case "memory", "tool-results":
				return fs.SkipDir
			}
			return nil
		}
		slash := filepath.ToSlash(path)
		if strings.Contains(slash, "/subagents/") {
			if subagentFileRE.MatchString(d.Name()) {
				out = append(out, path)
			}
			return nil
		}
		if !uuidFileRE.MatchString(d.Name()) {
			return nil
		}
		out = append(out, path)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// parentSessionIDFromPath returns the parent session UUID for a Claude
// Code subagent JSONL or "" when path doesn't look like a subagent.
// Agent-tool spawns sit directly under the parent's `subagents/`
// directory; Workflow-tool spawns nest deeper
// (`subagents/workflows/wf_<id>/agent-<hex>.jsonl`). Either way the
// parent UUID is the directory immediately above the innermost
// `subagents` component.
func parentSessionIDFromPath(path string) string {
	parts := strings.Split(filepath.ToSlash(path), "/")
	for i := len(parts) - 2; i > 0; i-- {
		if parts[i] != "subagents" {
			continue
		}
		if candidate := parts[i-1]; uuidLikeRE.MatchString(candidate) {
			return candidate
		}
		return ""
	}
	return ""
}

// uuidLikeRE matches a bare UUID (no extension). Mirrors uuidFileRE
// minus the `.jsonl` suffix so parentSessionIDFromPath can validate a
// directory name.
var uuidLikeRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// subagentSessionIDFromPath returns the canonical session id for a
// subagent JSONL — the filename stem (`agent-<id>`) — or "" when path
// is not a subagent transcript. The stem is the only stable identity a
// subagent has: every record inside carries the parent's sessionId.
// Mirrors Walk's admission criteria exactly so anything Walk admits
// gets filename-stem identity, even when the directory two levels up
// is not UUID-shaped and no parent edge can be recovered.
func subagentSessionIDFromPath(path string) string {
	if !strings.Contains(filepath.ToSlash(path), "/subagents/") {
		return ""
	}
	base := filepath.Base(path)
	if !subagentFileRE.MatchString(base) {
		return ""
	}
	return strings.TrimSuffix(base, ".jsonl")
}
