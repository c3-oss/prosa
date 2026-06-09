package hermes

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// marshalProjectedJSONL serializes one hermesMessage per line, in the
// order it appears in msgs, with `\n` between lines and no trailing
// newline. The result is the byte-stable shape PreserveProjectedJSONL
// writes to disk as raw/hermes/<YYYY>/<MM>/<session-id>.jsonl — the same
// JSONL the per-session `<id>.jsonl` flavor uses, just emitted from the
// state.db row instead of read from a transcript file.
//
// Determinism is load-bearing: the same input msgs must produce the same
// bytes across runs so PreserveProjectedJSONL's sha256 stays stable. The
// canonical encoder used here disables HTML escaping (so `&`/`<`/`>` in
// content round-trip literally) and strips the trailing newline that
// json.Encoder.Encode appends to each value.
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
		// Copy out of the encoder's buffer — Bytes() aliases buf.
		line := make(json.RawMessage, len(out))
		copy(line, out)
		lines = append(lines, line)
	}
	return lines, nil
}
