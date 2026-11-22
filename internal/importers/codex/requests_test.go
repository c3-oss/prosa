package codex

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/c3-oss/prosa/pkg/session"
	"github.com/stretchr/testify/require"
)

func TestThreadSettingsSetServiceTierPerTurn(t *testing.T) {
	usage := func(requests int) string {
		return fmt.Sprintf(`{"input_tokens":%d,"output_tokens":%d,"cached_input_tokens":0,"total_tokens":%d}`, requests*100, requests*10, requests*110)
	}
	n := 0
	event := func() string {
		n++
		return fmt.Sprintf(`{"type":"event_msg","timestamp":"2026-11-22T04:29:12Z","payload":{"type":"token_count","info":{"total_token_usage":%s,"last_token_usage":%s}}}`, usage(n), usage(1))
	}
	settings := func(fields string) string {
		return `{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-6.2-astra"` + fields + `}}}`
	}
	turn := func(fields string) string {
		return `{"type":"turn_context","payload":{"model":"gpt-6.2-astra","effort":"max"` + fields + `}}`
	}
	priority, standard, flex, fast := "priority", "default", "flex", "fast"
	steps := []struct {
		name        string
		lines       []string
		tier, speed *string
	}{
		{"before any settings", []string{turn(""), event()}, nil, nil},
		{"settings before the turn", []string{settings(`,"model_provider_id":"openai","service_tier":"priority"`), turn(""), event()}, &priority, nil},
		{"carried to the next turn", []string{turn(""), event()}, &priority, nil},
		{"settings after the turn opens", []string{turn(""), settings(`,"service_tier":"default"`), event()}, &standard, nil},
		{"settings applied mid-turn", []string{settings(`,"service_tier":"priority"`), event()}, &standard, nil},
		{"mid-turn settings reach the next turn", []string{turn(""), event()}, &priority, nil},
		{"turn override", []string{turn(`,"service_tier":"flex","speed":"fast"`), settings(`,"service_tier":"priority"`), event()}, &flex, &fast},
		{"override ends with its turn", []string{turn(""), event()}, &priority, nil},
		{"settings without a tier", []string{settings(""), turn(""), event()}, nil, nil},
	}
	var lines []string
	for _, step := range steps {
		lines = append(lines, step.lines...)
	}
	path := filepath.Join(t.TempDir(), "session.jsonl")
	require.NoError(t, os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600))
	sess, _, _, _, err := parseSession(context.Background(), path, slog.Default())
	require.NoError(t, err)
	require.Equal(t, session.RequestCoverageComplete, sess.RequestCoverage)
	require.Len(t, sess.Requests, len(steps))

	require.Nil(t, sess.Requests[0].Provider)
	for i, step := range steps {
		req := sess.Requests[i]
		require.Equal(t, step.tier, req.ServiceTier, step.name)
		require.Equal(t, step.speed, req.Speed, step.name)
		if i > 0 {
			require.Equal(t, "openai", *req.Provider, step.name)
		}
	}
}

func TestMeasuredRequestsMatchCumulativeAndModelChanges(t *testing.T) {
	first := `{"input_tokens":100,"output_tokens":20,"cached_input_tokens":30,"cache_write_input_tokens":5,"total_tokens":120}`
	second := `{"input_tokens":50,"output_tokens":10,"cached_input_tokens":20,"cache_write_input_tokens":3,"total_tokens":60}`
	total := `{"input_tokens":150,"output_tokens":30,"cached_input_tokens":50,"cache_write_input_tokens":8,"total_tokens":180}`
	event := func(sum, last string) string {
		return fmt.Sprintf(`{"type":"event_msg","timestamp":"2026-10-14T12:00:00Z","payload":{"type":"token_count","info":{"model_context_window":1000000,"total_token_usage":%s,"last_token_usage":%s}}}`, sum, last)
	}
	for _, tc := range []struct {
		name     string
		suffix   string
		coverage string
		count    int
	}{
		{"complete", "", session.RequestCoverageComplete, 2},
		{"gap", event(`{"input_tokens":300,"output_tokens":40,"cached_input_tokens":50,"cache_write_input_tokens":8,"total_tokens":340}`, second), session.RequestCoveragePartial, 2},
		{"reset", event(first, first), session.RequestCoveragePartial, 2},
		{"malformed nested usage", event(total, `{"input_tokens":"oops","output_tokens":10}`), session.RequestCoveragePartial, 2},
		{"rate-limit refresh without info", `{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex"}}}`, session.RequestCoverageComplete, 2},
		{"malformed event", `{"type":"event_msg","payload":{"type":"token_count","info":"oops"}}`, session.RequestCoveragePartial, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "session.jsonl")
			data := `{"type":"turn_context","payload":{"model":"gpt-6-astra","model_provider":"openai"}}` + "\n" + event(first, first) + "\n" + event(first, first) + "\n" + `{"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}` + "\n" + event(total, second) + "\n" + tc.suffix
			require.NoError(t, os.WriteFile(path, []byte(data), 0o600))
			sess, _, _, _, err := parseSession(context.Background(), path, slog.Default())
			require.NoError(t, err)
			require.Equal(t, tc.coverage, sess.RequestCoverage)
			require.Len(t, sess.Requests, tc.count)
			require.Equal(t, "gpt-6-astra", sess.Requests[0].Model)
			require.Equal(t, "gpt-6.1-sol", sess.Requests[1].Model)
			require.Equal(t, int64(100), *sess.Requests[0].PromptTokens)
			require.Equal(t, int64(8), sess.Usage.CacheCreationTokens)
			require.Equal(t, "openai", *sess.Requests[1].Provider)
		})
	}
}
