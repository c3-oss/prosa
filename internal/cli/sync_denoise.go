package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"strings"

	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/store"
)

const (
	// denoiseMaxScanBytes caps how many bytes we read from a raw file
	// when hunting for a clean user prompt. 1 MiB is comfortable: any
	// realistic first user message arrives well within the first few
	// dozen KB.
	denoiseMaxScanBytes = 1 << 20

	// denoiseBatchLimit ceils how many sessions we touch per `prosa
	// sync` run. Picked high enough to clear the typical backlog in
	// one go (~3 000 sessions) but not unbounded.
	denoiseBatchLimit = 5000
)

// runDenoisePass scans sessions whose stored first_prompt looks like
// agent-injected meta, reopens the raw JSONL, extracts the next
// non-boilerplate user message via scanRawForCleanPrompt, and
// UPDATEs the row. Idempotent: rows that survive a pass don't show
// up next time. Returns the number of rows actually rewritten.
func runDenoisePass(ctx context.Context, s *store.Store) int {
	candidates, err := s.ListSessionsWithBoilerplatePrompt(ctx, denoiseBatchLimit)
	if err != nil {
		slog.Warn("denoise list failed", "err", err)
		return 0
	}
	if len(candidates) == 0 {
		return 0
	}
	updated := 0
	for _, c := range candidates {
		if ctx.Err() != nil {
			break
		}
		clean, ok := scanRawForCleanPrompt(c.RawPath)
		if !ok || clean == "" {
			continue
		}
		if err := s.UpdateFirstPrompt(ctx, c.ID, clean); err != nil {
			slog.Warn("denoise update failed", "session", c.ID, "err", err)
			continue
		}
		updated++
	}
	return updated
}

// scanRawForCleanPrompt streams the raw transcript, extracts every
// candidate "content" string (or top-level "text" for Gemini's
// userInput shape), and returns the first one that passes
// render.CleanFirstPrompt. The scanner is JSON-line-oriented but
// tolerates non-JSON lines and short reads — agents disagree on
// schema details but every one stores text in a string field
// reachable via this pattern.
func scanRawForCleanPrompt(rawPath string) (string, bool) {
	f, err := os.Open(rawPath)
	if err != nil {
		return "", false
	}
	defer func() { _ = f.Close() }()

	reader := io.LimitReader(f, denoiseMaxScanBytes)
	sc := bufio.NewScanner(reader)
	// Some assistant turns are large; bump the line buffer up so we
	// don't truncate them mid-scan.
	buf := make([]byte, 0, 64*1024)
	sc.Buffer(buf, 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || line[0] != '{' {
			continue
		}
		for _, candidate := range extractStringFields(line) {
			cleaned, ok := render.CleanFirstPrompt(strings.TrimSpace(candidate))
			if ok && cleaned != "" {
				return truncateRunes(cleaned, 200), true
			}
		}
	}
	return "", false
}

// extractStringFields walks a JSON object/array and yields every
// string-valued leaf whose key is `content`, `text`, `prompt`, or
// `input`. This covers the four importers' user-content shapes
// without committing to a specific schema. Unknown shapes are
// skipped silently.
func extractStringFields(line string) []string {
	var v any
	if err := json.Unmarshal([]byte(line), &v); err != nil {
		return nil
	}
	out := []string{}
	walk(v, &out)
	return out
}

func walk(v any, out *[]string) {
	switch x := v.(type) {
	case map[string]any:
		// Emit every string leaf in a content/text/prompt/input key.
		// The role gate is intentionally absent: schemas vary too much
		// across importers, and downstream CleanFirstPrompt already
		// filters boilerplate, so being inclusive here costs nothing
		// and rescues prompts that the role-aware filter missed.
		for _, key := range []string{"content", "text", "prompt", "input"} {
			if val, ok := x[key]; ok {
				if s, ok := val.(string); ok {
					*out = append(*out, s)
				} else {
					walk(val, out)
				}
			}
		}
		// Descend into the rest of the object to catch nested turns.
		for k, val := range x {
			if k == "content" || k == "text" || k == "prompt" || k == "input" {
				continue // already handled above
			}
			walk(val, out)
		}
	case []any:
		for _, item := range x {
			walk(item, out)
		}
	}
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}
