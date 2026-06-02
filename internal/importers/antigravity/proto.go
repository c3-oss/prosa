package antigravity

import (
	"strings"
	"time"
	"unicode/utf8"

	"google.golang.org/protobuf/encoding/protowire"
)

// Antigravity protobuf field map. The on-disk SQLite schema is closed
// source, but the IPC localharness.proto schema (between the SDK and
// the harness binary) is shipped with the public google.antigravity
// Python SDK. We use the localharness types as a reference and
// reverse-engineered the storage-side proto by decoding real .db
// files under ~/.gemini/antigravity-cli/conversations/. The fields
// below are what we observed; every decode call degrades gracefully
// when a field is missing or has shifted.
//
// localharness.StepUpdate (the SDK-side step message; not byte-identical
// to what is stored, but the action_* oneof variants match what we
// observe in step_payload):
//
//	field 1  string cascade_id
//	field 2  string trajectory_id
//	field 3  uint32 step_index
//	field 4  enum State { ACTIVE=1, DONE=2, WAITING_FOR_USER=3, ERROR=4, TERMINAL_ERROR=5 }
//	field 5  enum Source { SYSTEM=1, USER=2, MODEL=3 }
//	field 6  enum Target { USER=1, MODEL=2, ENVIRONMENT=3 }
//	field 7  string error_message
//	field 8  string thinking
//	field 9  string text_delta
//	field 10 string thinking_delta
//	field 20 string text
//	field 21 ActionListDirectory list_directory
//	field 22 ActionFindFile      find_file
//	field 23 ActionSearchDirectory search_directory
//	field 24 ActionViewFile      view_file
//	field 25 ActionCreateFile    create_file
//	field 26 ActionEditFile      edit_file
//	field 27 ActionRunCommand    run_command
//	field 28 ActionCompaction    compaction
//	field 29 ActionInvokeSubagent invoke_subagent
//	field 30 ActionGenerateImage generate_image
//	field 31 ActionFinish        finish
//	field 32 ActionError         error
//
// localharness.UsageMetadata:
//
//	field 1 uint64 prompt_token_count
//	field 2 uint64 candidates_token_count
//	field 3 uint64 total_token_count
//	field 4 uint64 thoughts_token_count
//	field 5 uint64 cached_content_token_count
//
// (Source: google.antigravity SDK localharness_pb2.py, Apache 2.0.)
//
// The on-disk storage proto (what actually lives in the .db blobs) was
// reverse-engineered by inspecting real files and cross-referencing
// the Python SDK + the agy Go binary's embedded protobuf-go struct
// tags (Google internal google3/third_party/jetski/ paths).
//
// trajectory_metadata_blob.data (id="main"):
//
//	contains length-delimited string fields carrying the workspace URL
//	("file:///…"), the canonical repo slug, the git remote URL, and the
//	git branch name. We walk strings depth-recursive and pick the first
//	one that parses as a "file://" URL.
//
// steps.metadata:
//
//	field 1  (bytes):  google.protobuf.Timestamp #1  <- step event time
//	  inner field 1 (varint): seconds
//	  inner field 2 (varint): nanos
//	field 3  (varint): some per-step counter (4, 5, 2, …)
//	field 6/7/8 (bytes): additional Timestamps in tool-step rows
//	field 9  (bytes):  stats sub-message with token-like varints
//	  (input/output/reasoning/cached split — semantics not yet
//	  pinned down; see parse.go::readUsage).
//	field 12 (bytes): 36-byte trajectory UUID
//	field 20 (bytes): nested ref block (trajectory + cascade UUIDs)
//	field 26 (bytes): list of {status, timestamp} pairs
//	field 32 (bytes): another Timestamp (close time?)
//
// steps.step_payload (per step_type):
//
//	field 1  (varint): step_type (mirrors steps.step_type column)
//	field 4  (varint): status (mirrors steps.status column)
//	field 5  (bytes):  embedded copy of the metadata layout above
//	field 19 (bytes): payload sub-message
//	  sub-field 2 (bytes): user prompt text (present only for step_type=14)
//	step_type=8/21/132/... : embeds a bareword tool name + JSON object
//	  {"toolAction":…,"toolSummary":…} in adjacent string fields. We
//	  scan strings depth-recursive and match the pair.
//	step_type=15/23 (turn boundary): no extractable content today.
//
// gen_metadata.data: UNVERIFIED. Carries short hex strings that look like
// model-id hashes (e.g. 8ce6e85a, 292cbbff) plus the session UUID.
// gen_metadata.size: candidate token count for the generation; treated
// as a best-effort signal — see parse.go::readUsage.
const (
	stepPayloadFieldText protowire.Number = 2

	timestampFieldSeconds protowire.Number = 1
	timestampFieldNanos   protowire.Number = 2

	scanMaxDepth = 6
)

// stepPayloadFieldForType maps the on-disk step_type column to the
// gemini_coder.Step proto field that carries the action-specific
// sub-message. Sourced from cortex.proto's CortexStepType enum and
// gemini_coder.Step's oneof variants (extracted from the agy Go
// binary's embedded FileDescriptorProto).
//
//	8   VIEW_FILE        -> field 14 (CortexStepViewFile)
//	9   LIST_DIRECTORY   -> field 15 (CortexStepListDirectory)
//	14  USER_INPUT       -> field 19 (CortexStepUserInput)
//	15  PLANNER_RESPONSE -> field 20 (CortexStepPlannerResponse)  <- assistant text
//	17  ERROR_MESSAGE    -> field 24 (CortexStepErrorMessage)
//	21  RUN_COMMAND      -> field 28 (CortexStepRunCommand)
//	23  CHECKPOINT       -> field 30 (CortexStepCheckpoint)
//	132 GENERIC          -> field 132 (CortexStepGeneric — used for the
//	                       custom permissions / generic tool calls)

// readPlannerResponseText pulls the assistant's text reply out of a
// step_type=15 (PLANNER_RESPONSE) step_payload. The path is
// gemini_coder.Step.planner_response (field 20) → CortexStepPlannerResponse
// field 1 (the rendered text). Field 8 carries the same text; we prefer
// field 1.
func readPlannerResponseText(payload []byte) (string, bool) {
	fields, err := parseFields(payload)
	if err != nil || len(fields) == 0 {
		return "", false
	}
	resp, ok := findField(fields, 20)
	if !ok || resp.Wire != protowire.BytesType {
		return "", false
	}
	sub, err := parseFields(resp.B)
	if err != nil {
		return "", false
	}
	for _, f := range sub {
		if f.Num != 1 || f.Wire != protowire.BytesType {
			continue
		}
		if !isPrintableUTF8(f.B) {
			continue
		}
		return string(f.B), true
	}
	return "", false
}

// Field captures one decoded protobuf field. Varint/fixed values land in
// V; length-delimited content lands in B. Callers dispatch on Wire.
type Field struct {
	Num  protowire.Number
	Wire protowire.Type
	V    uint64
	B    []byte
}

// parseFields walks buf and returns every top-level field. Returns a
// nil slice for empty input. Stops at the first malformed tag/value —
// callers get the partial slice plus the error so they can decide how
// much to trust.
func parseFields(buf []byte) ([]Field, error) {
	var out []Field
	for len(buf) > 0 {
		num, wire, n := protowire.ConsumeTag(buf)
		if n < 0 {
			return out, protowire.ParseError(n)
		}
		buf = buf[n:]
		f := Field{Num: num, Wire: wire}
		switch wire {
		case protowire.VarintType:
			v, m := protowire.ConsumeVarint(buf)
			if m < 0 {
				return out, protowire.ParseError(m)
			}
			f.V = v
			buf = buf[m:]
		case protowire.Fixed32Type:
			v, m := protowire.ConsumeFixed32(buf)
			if m < 0 {
				return out, protowire.ParseError(m)
			}
			f.V = uint64(v)
			buf = buf[m:]
		case protowire.Fixed64Type:
			v, m := protowire.ConsumeFixed64(buf)
			if m < 0 {
				return out, protowire.ParseError(m)
			}
			f.V = v
			buf = buf[m:]
		case protowire.BytesType:
			b, m := protowire.ConsumeBytes(buf)
			if m < 0 {
				return out, protowire.ParseError(m)
			}
			f.B = b
			buf = buf[m:]
		default:
			// Groups (StartGroup/EndGroup) are deprecated proto2 and
			// have not been observed in antigravity payloads. Skip
			// the whole record rather than guess.
			m := protowire.ConsumeFieldValue(num, wire, buf)
			if m < 0 {
				return out, protowire.ParseError(m)
			}
			buf = buf[m:]
			continue
		}
		out = append(out, f)
	}
	return out, nil
}

// findField returns the first field with the given number.
func findField(fields []Field, num protowire.Number) (Field, bool) {
	for _, f := range fields {
		if f.Num == num {
			return f, true
		}
	}
	return Field{}, false
}

// readTimestamp decodes a google.protobuf.Timestamp sub-message
// {1: seconds varint, 2: nanos varint} into a UTC time.Time. Returns
// (zero, false) when the bytes don't decode or carry no seconds.
func readTimestamp(buf []byte) (time.Time, bool) {
	fields, err := parseFields(buf)
	if err != nil || len(fields) == 0 {
		return time.Time{}, false
	}
	sec, ok := findField(fields, timestampFieldSeconds)
	if !ok || sec.Wire != protowire.VarintType {
		return time.Time{}, false
	}
	var nanos int64
	if n, ok := findField(fields, timestampFieldNanos); ok && n.Wire == protowire.VarintType {
		nanos = int64(n.V)
	}
	return time.Unix(int64(sec.V), nanos).UTC(), true
}

// readStepEventTime extracts Timestamp #1 from a steps.metadata blob —
// the protobuf path is top-level field 1 (length-delimited
// google.protobuf.Timestamp). Returns (zero, false) when the field is
// missing or doesn't decode.
func readStepEventTime(metadata []byte) (time.Time, bool) {
	fields, err := parseFields(metadata)
	if err != nil || len(fields) == 0 {
		return time.Time{}, false
	}
	ts, ok := findField(fields, 1)
	if !ok || ts.Wire != protowire.BytesType {
		return time.Time{}, false
	}
	return readTimestamp(ts.B)
}

// StepUsage captures the per-step token usage decoded out of
// CortexStepMetadata.model_usage (field 9), which carries an
// exa.codeium_common_pb.ModelUsageStats sub-message. The schema was
// recovered from the agy Go binary's embedded
// protobuf-go struct tags (google3/third_party/jetski/codeium_common_pb/):
//
//	field 1  enum Model         model_id          (e.g. value 1020 ≈ gemini-3.5-flash-low)
//	field 2  uint64              input_tokens
//	field 3  uint64              output_tokens
//	field 4  uint64              cache_write_tokens
//	field 5  uint64              cache_read_tokens
//	field 9  uint64              thinking_output_tokens
//	field 10 uint64              response_output_tokens
//	field 11 string              request_id
//
// Field 6 carries an api_provider enum (small constant in observed
// data) and is not tracked. The InputTokens value reflects the FULL
// per-call prompt — system instructions + tool definitions + the
// running context — so prosa surfaces it directly without trying to
// disentangle the user prompt from the system prompt.
type StepUsage struct {
	InputTokens          int64
	OutputTokens         int64
	CacheReadTokens      int64
	CacheWriteTokens     int64
	ThinkingOutputTokens int64
	ResponseOutputTokens int64
	Present              bool
}

// readStepUsage walks a steps.metadata blob and returns the per-step
// ModelUsageStats. Returns Present=false when field 9 is absent (steps
// without a model invocation: user input, checkpoints, etc).
func readStepUsage(metadata []byte) StepUsage {
	fields, err := parseFields(metadata)
	if err != nil || len(fields) == 0 {
		return StepUsage{}
	}
	stats, ok := findField(fields, 9)
	if !ok || stats.Wire != protowire.BytesType {
		return StepUsage{}
	}
	sub, err := parseFields(stats.B)
	if err != nil || len(sub) == 0 {
		return StepUsage{}
	}
	out := StepUsage{Present: true}
	for _, f := range sub {
		if f.Wire != protowire.VarintType {
			continue
		}
		switch f.Num {
		case 2:
			out.InputTokens = int64(f.V)
		case 3:
			out.OutputTokens = int64(f.V)
		case 4:
			out.CacheWriteTokens = int64(f.V)
		case 5:
			out.CacheReadTokens = int64(f.V)
		case 9:
			out.ThinkingOutputTokens = int64(f.V)
		case 10:
			out.ResponseOutputTokens = int64(f.V)
		}
	}
	return out
}

// readGenerationInfo pulls the human-readable model identifier (and a
// few flags) out of a gen_metadata.data blob. Observed schema:
//
//	field 1 (sub-message) carries the generation record:
//	  sub-field 19 (bytes string) = short model name, e.g. "gemini-3-flash-a"
//	                                (truncated; up to 16 chars)
//	  sub-field 21 (bytes string) = display label, e.g. "Gemini 3.5 Flash (Medium)"
//	  sub-field 20 (repeated key/value pairs) = trajectory_id, model_enum,
//	                                            used_claude, last_step_index, …
//
// We prefer the full model name from executor_metadata.field 28 (see
// readExecutorModelName) and fall back to this for older sessions.
type GenerationInfo struct {
	ModelName    string
	DisplayLabel string
}

func readGenerationInfo(blob []byte) GenerationInfo {
	var out GenerationInfo
	fields, err := parseFields(blob)
	if err != nil {
		return out
	}
	root, ok := findField(fields, 1)
	if !ok || root.Wire != protowire.BytesType {
		return out
	}
	sub, err := parseFields(root.B)
	if err != nil {
		return out
	}
	for _, f := range sub {
		if f.Wire != protowire.BytesType {
			continue
		}
		switch f.Num {
		case 19:
			if isPrintableUTF8(f.B) {
				out.ModelName = string(f.B)
			}
		case 21:
			if isPrintableUTF8(f.B) {
				out.DisplayLabel = string(f.B)
			}
		}
	}
	return out
}

// readExecutorModelName returns the canonical (non-truncated) model
// identifier from executor_metadata.data. The protobuf path is
// ExecutorMetadata.cascade_config (field 10) → its active variant
// (field 1) → model_name (field 28, length-delimited string).
//
// Verified by running `agy -p ...` against a controlled prompt: this
// path holds the full model id (e.g. "gemini-3.5-flash-low"), while
// gen_metadata only carries a 16-char prefix.
func readExecutorModelName(blob []byte) (string, bool) {
	fields, err := parseFields(blob)
	if err != nil {
		return "", false
	}
	cfg, ok := findField(fields, 10)
	if !ok || cfg.Wire != protowire.BytesType {
		return "", false
	}
	inner, err := parseFields(cfg.B)
	if err != nil {
		return "", false
	}
	variant, ok := findField(inner, 1)
	if !ok || variant.Wire != protowire.BytesType {
		return "", false
	}
	sub, err := parseFields(variant.B)
	if err != nil {
		return "", false
	}
	name, ok := findField(sub, 28)
	if !ok || name.Wire != protowire.BytesType {
		return "", false
	}
	if !isPrintableUTF8(name.B) {
		return "", false
	}
	return string(name.B), true
}

// readStepUserPrompt extracts the user prompt text from a step's
// payload blob. The path is payload field 19 (sub-message) → sub-field
// 2 (string). Returns ("", false) when either hop is missing.
func readStepUserPrompt(payload []byte) (string, bool) {
	fields, err := parseFields(payload)
	if err != nil || len(fields) == 0 {
		return "", false
	}
	inner, ok := findField(fields, 19)
	if !ok || inner.Wire != protowire.BytesType {
		return "", false
	}
	sub, err := parseFields(inner.B)
	if err != nil || len(sub) == 0 {
		return "", false
	}
	text, ok := findField(sub, stepPayloadFieldText)
	if !ok || text.Wire != protowire.BytesType || !utf8.Valid(text.B) {
		return "", false
	}
	return string(text.B), true
}

// scanStrings walks buf depth-recursive and invokes fn for every
// length-delimited field whose bytes look like printable UTF-8. fn may
// return false to stop traversal early. Recursion bounded by
// scanMaxDepth so adversarial blobs cannot spin.
func scanStrings(buf []byte, fn func(string) bool) {
	var walk func(b []byte, depth int) bool
	walk = func(b []byte, depth int) bool {
		fields, err := parseFields(b)
		if err != nil {
			return true
		}
		for _, f := range fields {
			if f.Wire != protowire.BytesType {
				continue
			}
			if isPrintableUTF8(f.B) {
				if !fn(string(f.B)) {
					return false
				}
				continue
			}
			if depth < scanMaxDepth {
				if !walk(f.B, depth+1) {
					return false
				}
			}
		}
		return true
	}
	walk(buf, 0)
}

// scanToolCall finds the first embedded JSON object whose key prefix
// matches a known antigravity tool-arg signature and returns it along
// with the bareword string that immediately preceded it in scan order.
// Returns ("", "", false) when no pair is found.
func scanToolCall(buf []byte) (toolName, jsonArgs string, ok bool) {
	var prev string
	scanStrings(buf, func(s string) bool {
		if looksLikeToolJSON(s) {
			toolName = prev
			jsonArgs = s
			ok = true
			return false
		}
		if looksLikeBareword(s) {
			prev = s
		}
		return true
	})
	return
}

// firstLargeString returns the first scanned string longer than
// minRunes that is not a tool-args JSON span. Used as a fallback for
// step types whose semantics we have not yet pinned down — gives the
// session timeline at least one text snippet per unclassified step.
func firstLargeString(buf []byte, minRunes int) (string, bool) {
	var out string
	scanStrings(buf, func(s string) bool {
		if looksLikeToolJSON(s) {
			return true
		}
		if utf8.RuneCountInString(s) < minRunes {
			return true
		}
		out = s
		return false
	})
	return out, out != ""
}

var toolJSONSignatures = []string{
	`{"toolAction"`,
	`{"toolSummary"`,
	`{"AbsolutePath"`,
	`{"CommandLine"`,
	`{"Cwd"`,
	`{"FilePath"`,
	`{"Query"`,
	`{"Pattern"`,
}

func looksLikeToolJSON(s string) bool {
	if len(s) < 2 || s[0] != '{' {
		return false
	}
	for _, key := range toolJSONSignatures {
		if strings.HasPrefix(s, key) {
			return true
		}
	}
	return false
}

// looksLikeBareword matches identifier-style tool names like
// "view_file", "run_command", "list-permissions". Rejects empty,
// over-long, whitespace-bearing, or pure-numeric strings.
func looksLikeBareword(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	hasLetter := false
	for _, r := range s {
		switch {
		case r == '_' || r == '-':
		case r >= 'a' && r <= 'z':
			hasLetter = true
		case r >= 'A' && r <= 'Z':
			hasLetter = true
		case r >= '0' && r <= '9':
		default:
			return false
		}
	}
	return hasLetter
}

// isPrintableUTF8 reports whether b decodes as valid UTF-8 with no
// control characters outside tab/newline/carriage-return. Empty input
// returns false so callers fall back to nested decode.
func isPrintableUTF8(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	if !utf8.Valid(b) {
		return false
	}
	for _, r := range string(b) {
		if r == '\t' || r == '\n' || r == '\r' {
			continue
		}
		if r < 0x20 || r == 0x7F {
			return false
		}
	}
	return true
}
