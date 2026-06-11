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
	// denoiseMaxScanBytes: any real first-user-message is well within the first few KB.
	denoiseMaxScanBytes = 1 << 20

	// denoiseBatchLimit: high enough to clear a typical backlog in one run (~3000 sessions).
	denoiseBatchLimit = 5000
)

// runDenoisePass rewrites first_prompt for sessions whose stored value is
// agent-injected boilerplate. Idempotent: converged rows don't appear next run.
// Returns the number of rows actually rewritten.
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

// scanRawForCleanPrompt returns the first non-boilerplate user text found in
// the raw JSONL, tolerating non-JSON lines and schema variation across agents.
func scanRawForCleanPrompt(rawPath string) (string, bool) {
	f, err := os.Open(rawPath)
	if err != nil {
		return "", false
	}
	defer func() { _ = f.Close() }()

	reader := io.LimitReader(f, denoiseMaxScanBytes)
	sc := bufio.NewScanner(reader)
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

// extractStringFields yields every string leaf under content/text/prompt/input
// keys, covering importer user-content shapes without committing to a schema.
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
		// No role gate: schemas vary across importers; CleanFirstPrompt filters boilerplate downstream.
		for _, key := range []string{"content", "text", "prompt", "input"} {
			if val, ok := x[key]; ok {
				if s, ok := val.(string); ok {
					*out = append(*out, s)
				} else {
					walk(val, out)
				}
			}
		}
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
