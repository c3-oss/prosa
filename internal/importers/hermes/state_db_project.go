package hermes

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// marshalProjectedJSONL serializes msgs as one JSON object per line with no
// trailing newline, matching the shape of per-session <id>.jsonl files.
// HTML escaping is disabled so `&`/`<`/`>` round-trip literally; the result
// must be byte-stable across runs so PreserveProjectedJSONL's sha256 stays
// stable.
func marshalProjectedJSONL(msgs []hermesMessage) ([]json.RawMessage, error) {
	lines := make([]json.RawMessage, 0, len(msgs))
	for i, m := range msgs {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(m); err != nil {
			return nil, fmt.Errorf("marshal hermes message %d: %w", i, err)
		}
		out := buf.Bytes()
		// json.Encoder appends '\n' to every Encode; PreserveProjectedJSONL
		// adds its own '\n' separators between lines, so strip it here to
		// keep the on-disk content byte-stable.
		if n := len(out); n > 0 && out[n-1] == '\n' {
			out = out[:n-1]
		}
		line := make(json.RawMessage, len(out))
		copy(line, out)
		lines = append(lines, line)
	}
	return lines, nil
}
