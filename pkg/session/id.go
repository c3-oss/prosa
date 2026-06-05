package session

import "fmt"

// MaxIDLen bounds an accepted session ID. Agent session IDs are UUIDs or
// short slugs in practice; 128 bytes leaves generous headroom while keeping
// the value safe to embed in filesystem paths, S3 keys, and SSE frames.
const MaxIDLen = 128

// ValidateID reports whether id is a safe session identifier.
//
// The same id is used by importers to build the raw transcript destination
// path (filepath.Join) and by the server to build S3 object keys, Postgres
// rows that fire pg_notify into the SSE stream, and s3:// URIs. None of
// those sinks sanitize the value, so an unvalidated id read from an
// attacker-controlled transcript can traverse out of the raw root, inject
// newlines into SSE framing, or confuse URI parsing.
//
// A valid id is 1..MaxIDLen bytes drawn from [A-Za-z0-9._-] and never
// contains a ".." sequence. This accepts every real agent id (UUIDs and
// slugs) while rejecting slashes, backslashes, newlines, path traversal,
// and non-ASCII.
func ValidateID(id string) error {
	if id == "" {
		return fmt.Errorf("session id is empty")
	}
	if len(id) > MaxIDLen {
		return fmt.Errorf("session id must be at most %d bytes", MaxIDLen)
	}
	if containsDotDot(id) {
		return fmt.Errorf("session id must not contain %q", "..")
	}
	for i := 0; i < len(id); i++ {
		if !isIDChar(id[i]) {
			return fmt.Errorf("session id byte %d (%q) is not allowed; must be one of [A-Za-z0-9._-]", i, id[i])
		}
	}
	return nil
}

func containsDotDot(s string) bool {
	for i := 0; i+1 < len(s); i++ {
		if s[i] == '.' && s[i+1] == '.' {
			return true
		}
	}
	return false
}

func isIDChar(c byte) bool {
	return (c >= 'A' && c <= 'Z') ||
		(c >= 'a' && c <= 'z') ||
		(c >= '0' && c <= '9') ||
		c == '.' || c == '_' || c == '-'
}
