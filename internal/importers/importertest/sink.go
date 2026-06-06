package importertest

import (
	"context"

	"github.com/c3-oss/prosa/pkg/session"
)

// Sink implements importer.Sink and importer.SkipCache for importer tests.
// The skip cache mirrors the production store's hash-keyed policy skip
// markers, so no_usage/state_seen idempotency has to round-trip in tests.
type Sink struct {
	Sessions map[string]session.Session
	Tools    map[string][]session.ToolUsage
	Turns    map[string][]session.Turn
	Hashes   map[string]string
	Skips    map[string]map[string]string
}

func NewSink() *Sink {
	return &Sink{
		Sessions: map[string]session.Session{},
		Tools:    map[string][]session.ToolUsage{},
		Turns:    map[string][]session.Turn{},
		Hashes:   map[string]string{},
		Skips:    map[string]map[string]string{},
	}
}

func (s *Sink) WriteSession(_ context.Context, sess session.Session, tools []session.ToolUsage, turns []session.Turn, hash string) error {
	s.Sessions[sess.ID] = sess
	s.Tools[sess.ID] = tools
	s.Turns[sess.ID] = turns
	s.Hashes[sess.ID] = hash
	return nil
}

func (s *Sink) LastHash(_ context.Context, sessionID string) (string, bool, error) {
	hash, ok := s.Hashes[sessionID]
	return hash, ok, nil
}

func (s *Sink) LastImportSkip(_ context.Context, sessionID, reason string) (string, bool, error) {
	if byReason, ok := s.Skips[sessionID]; ok {
		hash, ok := byReason[reason]
		return hash, ok, nil
	}
	return "", false, nil
}

func (s *Sink) RecordImportSkip(_ context.Context, sessionID, hash, reason string) error {
	if s.Skips[sessionID] == nil {
		s.Skips[sessionID] = map[string]string{}
	}
	s.Skips[sessionID][reason] = hash
	return nil
}
