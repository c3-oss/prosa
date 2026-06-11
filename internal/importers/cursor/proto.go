package cursor

import (
	"crypto/md5"
	"encoding/hex"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"google.golang.org/protobuf/encoding/protowire"
)

// Cursor's blobs table mixes two payload kinds:
//
//   - JSON messages: `{"role":"user|assistant|system|tool","content":…,
//     "id":…,"providerOptions":…}` — extracted as canonical Turn rows by
//     parse.go.
//   - Protobuf state nodes: undocumented binary records carrying event
//     timestamps, file path references (when the model viewed/edited a
//     file), todo items, and SHA-256 pointers between blobs. Cursor is
//     closed source, so we don't have a .proto; the helpers below scan
//     wire-format fields without a schema and pull out two specific
//     signals:
//
//       a) **Timestamps** — any varint in the unix-ms range (≥
//          minMsEpoch). Empirically the `0A20` event-node family stores
//          its event time at field 26; todo-item families (`0A0A`,
//          `0A15`) store created/updated at fields 4 and 5. We sweep
//          every blob without committing to a single field number.
//
//       b) **Absolute filesystem paths** — every printable UTF-8 string
//          field that starts with "/" and contains a slash. Used to
//          reverse the workspace hash (Cursor stores chat dirs at
//          `~/.cursor/chats/<md5(workspacePath)>/<agentID>/store.db`).
//
// The scanner is bounded by maxScanDepth to keep adversarial blobs from
// spinning; an unknown wire type halts the walk gracefully.

const (
	// Unix-ms range we accept as a "looks like a timestamp" signal.
	// 1.5e12 ≈ 2017-07-14; 2.5e12 ≈ 2049-04. Tightening helps avoid
	// false positives from random large varints.
	minMsEpoch = int64(1_500_000_000_000)
	maxMsEpoch = int64(2_500_000_000_000)

	maxScanDepth = 6
)

// scanBlob walks the protobuf wire form of a cursor blob and calls back
// once per plausible timestamp varint and once per absolute-path
// string field. It tolerates non-protobuf payloads (e.g. JSON blobs)
// by returning early on the first malformed tag.
func scanBlob(data []byte, onTimestamp func(int64), onPath func(string)) {
	if len(data) == 0 {
		return
	}
	var walk func(b []byte, depth int)
	walk = func(b []byte, depth int) {
		for len(b) > 0 {
			num, wire, n := protowire.ConsumeTag(b)
			if n < 0 {
				return
			}
			b = b[n:]
			_ = num
			switch wire {
			case protowire.VarintType:
				v, m := protowire.ConsumeVarint(b)
				if m < 0 {
					return
				}
				b = b[m:]
				if iv := int64(v); iv >= minMsEpoch && iv <= maxMsEpoch {
					onTimestamp(iv)
				}
			case protowire.BytesType:
				bb, m := protowire.ConsumeBytes(b)
				if m < 0 {
					return
				}
				b = b[m:]
				if looksLikeAbsolutePath(bb) {
					onPath(string(bb))
					continue
				}
				if depth < maxScanDepth {
					walk(bb, depth+1)
				}
			case protowire.Fixed32Type:
				if len(b) < 4 {
					return
				}
				b = b[4:]
			case protowire.Fixed64Type:
				if len(b) < 8 {
					return
				}
				b = b[8:]
			default:
				return
			}
		}
	}
	walk(data, 0)
}

// looksLikeAbsolutePath returns true for printable UTF-8 byte slices
// that start with "/" and contain at least one additional slash —
// i.e. things shaped like POSIX absolute paths.
func looksLikeAbsolutePath(b []byte) bool {
	if len(b) < 4 || len(b) > 4096 {
		return false
	}
	if b[0] != '/' {
		return false
	}
	if !utf8.Valid(b) {
		return false
	}
	slashes := 0
	for _, r := range string(b) {
		if r == '/' {
			slashes++
		}
		if r == '\t' || r == '\n' || r == '\r' {
			return false
		}
		if r < 0x20 || r == 0x7F {
			return false
		}
	}
	return slashes >= 2
}

// workspaceHashFromStorePath extracts the <workspaceHash> path segment
// from a Cursor store.db path of the form
// ".../chats/<workspaceHash>/<agentID>/store.db". Returns "" when the
// path doesn't match the expected layout.
func workspaceHashFromStorePath(path string) string {
	dir := filepath.Dir(path)     // .../chats/<hash>/<agentID>
	agentDir := filepath.Dir(dir) // .../chats/<hash>
	parent := filepath.Base(agentDir)
	if len(parent) != 32 {
		return ""
	}
	for _, c := range parent {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return ""
		}
	}
	return parent
}

// resolveWorkspacePath returns the longest absolute filesystem prefix
// from candidates whose md5 hash equals workspaceHash. Cursor's chat
// directory is named `md5(workspacePath)` — see docs/sources/cursor.md —
// so this is a reliable inverse when the blobs carry any file the model touched.
func resolveWorkspacePath(workspaceHash string, candidates []string) string {
	if workspaceHash == "" || len(candidates) == 0 {
		return ""
	}
	seen := map[string]struct{}{}
	for _, p := range candidates {
		clean := filepath.Clean(p)
		for {
			if _, ok := seen[clean]; ok {
				break
			}
			seen[clean] = struct{}{}
			parent := filepath.Dir(clean)
			if parent == clean || parent == "/" {
				break
			}
			clean = parent
		}
	}
	var best string
	for cand := range seen {
		if len(cand) <= len(best) {
			continue
		}
		sum := md5.Sum([]byte(cand))
		if hex.EncodeToString(sum[:]) == workspaceHash {
			best = cand
		}
	}
	return best
}

// workspacePathFromPlanURI extracts the workspace root from a
// `currentPlanUri` value of the form
// `file:///abs/path/to/workspace/.cursor/plan-<uuid>.md`. Returns ""
// when the URI doesn't carry a `/.cursor/` marker.
func workspacePathFromPlanURI(uri string) string {
	const prefix = "file://"
	if !strings.HasPrefix(uri, prefix) {
		return ""
	}
	p := strings.TrimPrefix(uri, prefix)
	idx := strings.Index(p, "/.cursor/")
	if idx <= 0 {
		return ""
	}
	return p[:idx]
}

// workspacePathFromUserInfo scans the body of a Cursor `<user_info>`
// system-injected blob for a `Workspace Path:` literal and returns the
// path it points to. Used as a third-tier fallback when neither the
// plan URI nor the md5 reverse turns up a verified workspace root.
func workspacePathFromUserInfo(content string) string {
	const tag = "Workspace Path:"
	idx := strings.Index(content, tag)
	if idx < 0 {
		return ""
	}
	rest := content[idx+len(tag):]
	rest = strings.TrimLeft(rest, " \t")
	end := strings.IndexAny(rest, "\r\n<")
	if end < 0 {
		end = len(rest)
	}
	candidate := strings.TrimSpace(rest[:end])
	if !strings.HasPrefix(candidate, "/") {
		return ""
	}
	return candidate
}
