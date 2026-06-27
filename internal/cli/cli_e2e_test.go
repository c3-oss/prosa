//go:build testintegration

package cli_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const e2eSessionID = "019c537c-493c-7a11-b1ef-6e742bf9f7d1"

func TestCLIEndToEnd(t *testing.T) {
	exe := buildProsa(t)
	env := newCLIEnv(t)

	missing := runProsa(t, exe, env, "--all")
	require.Equal(t, 1, missing.code)
	require.Empty(t, missing.stdout)
	require.Contains(t, missing.stderr, "prosa store not initialized; run `prosa sync` first")

	badFlag := runProsa(t, exe, env, "--definitely-not-a-flag")
	require.Equal(t, 1, badFlag.code)
	require.Contains(t, badFlag.stderr, "unknown flag")

	writeCodexTranscript(t, env.home)

	firstSync := runProsa(t, exe, env, "sync")
	require.Equal(t, 0, firstSync.code, firstSync.stderr)
	require.Empty(t, firstSync.stdout)
	require.Contains(t, firstSync.stderr, "prosa sync · complete")
	require.Contains(t, firstSync.stderr, "Live:     imported 1 · skipped 0 · errors 0")

	secondSync := runProsa(t, exe, env, "sync")
	require.Equal(t, 0, secondSync.code, secondSync.stderr)
	require.Empty(t, secondSync.stdout)
	require.Contains(t, secondSync.stderr, "Live:     imported 0 · skipped 1 · errors 0")

	overwriteSync := runProsa(t, exe, env, "sync", "--overwrite")
	require.Equal(t, 0, overwriteSync.code, overwriteSync.stderr)
	require.Empty(t, overwriteSync.stdout)
	require.Contains(t, overwriteSync.stderr, "Live:     imported 1 · skipped 0 · errors 0")

	timeline := runProsa(t, exe, env, "--all", "--json", "--since", "2026-05-01", "--limit", "1")
	require.Equal(t, 0, timeline.code, timeline.stderr)
	require.Empty(t, timeline.stderr)

	lines := strings.Split(strings.TrimSpace(timeline.stdout), "\n")
	require.Len(t, lines, 1)

	var row map[string]any
	require.NoError(t, json.Unmarshal([]byte(lines[0]), &row))
	require.Equal(t, e2eSessionID, row["id"])
	require.Equal(t, "codex", row["agent"])
	require.Equal(t, "explain entanglement", row["first_prompt"])
}

type cliEnv struct {
	home       string
	dataHome   string
	configHome string
	tmp        string
}

func newCLIEnv(t *testing.T) cliEnv {
	t.Helper()
	root := t.TempDir()
	env := cliEnv{
		home:       filepath.Join(root, "home"),
		dataHome:   filepath.Join(root, "prosa-data"),
		configHome: filepath.Join(root, "prosa-config"),
		tmp:        filepath.Join(root, "tmp"),
	}
	for _, dir := range []string{env.home, env.dataHome, env.configHome, env.tmp} {
		require.NoError(t, os.MkdirAll(dir, 0o755))
	}
	return env
}

func (e cliEnv) vars() []string {
	env := []string{
		"HOME=" + e.home,
		"PATH=" + os.Getenv("PATH"),
		"PROSA_HOME=" + e.dataHome,
		"PROSA_CONFIG_HOME=" + e.configHome,
		"TMPDIR=" + e.tmp,
		"CI=1",
	}
	for _, key := range []string{"SystemRoot", "WINDIR"} {
		if value := os.Getenv(key); value != "" {
			env = append(env, key+"="+value)
		}
	}
	return env
}

type cliRun struct {
	code   int
	stdout string
	stderr string
}

func runProsa(t *testing.T, exe string, env cliEnv, args ...string) cliRun {
	t.Helper()
	cmd := exec.Command(exe, args...)
	cmd.Env = env.vars()
	cmd.Dir = env.home

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	code := 0
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			require.NoError(t, err)
		}
		code = exitErr.ExitCode()
	}

	return cliRun{
		code:   code,
		stdout: stdout.String(),
		stderr: stderr.String(),
	}
}

func buildProsa(t *testing.T) string {
	t.Helper()

	root := repoRoot(t)
	exe := filepath.Join(t.TempDir(), "prosa")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}

	cmd := exec.Command("go", "build", "-o", exe, "./cmd/prosa")
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	require.NoErrorf(t, err, "go build ./cmd/prosa:\n%s", out)
	return exe
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	require.True(t, ok)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func writeCodexTranscript(t *testing.T, home string) {
	t.Helper()
	base := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	dir := filepath.Join(home, ".codex", "sessions", base.Format("2006"), base.Format("01"), base.Format("02"))
	require.NoError(t, os.MkdirAll(dir, 0o755))

	path := filepath.Join(dir, "rollout-"+base.Format("2006-01-02T15-04-05")+"-"+e2eSessionID+".jsonl")
	writeJSONL(t, path, []map[string]any{
		{
			"type":      "session_meta",
			"timestamp": base.Format(time.RFC3339Nano),
			"payload": map[string]any{
				"id":         e2eSessionID,
				"timestamp":  base.Format(time.RFC3339Nano),
				"cwd":        "/Users/test/proj",
				"originator": "codex_cli_rs",
			},
		},
		{
			"type":      "turn_context",
			"timestamp": base.Add(time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"model": "gpt-5-codex",
				"cwd":   "/Users/test/proj",
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(5 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type":    "message",
				"role":    "user",
				"content": []map[string]any{{"type": "input_text", "text": "explain entanglement"}},
			},
		},
		{
			"type":      "response_item",
			"timestamp": base.Add(10 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type":    "message",
				"role":    "assistant",
				"content": []map[string]any{{"type": "output_text", "text": "particles share state across distance"}},
			},
		},
		{
			"type":      "event_msg",
			"timestamp": base.Add(15 * time.Second).Format(time.RFC3339Nano),
			"payload": map[string]any{
				"type": "token_count",
				"info": map[string]any{
					"total_token_usage": map[string]any{
						"input_tokens":  100,
						"output_tokens": 20,
						"total_tokens":  120,
					},
				},
			},
		},
	})
}

func writeJSONL(t *testing.T, path string, records []map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	for _, record := range records {
		body, err := json.Marshal(record)
		require.NoError(t, err)
		buf.Write(body)
		buf.WriteByte('\n')
	}
	require.NoError(t, os.WriteFile(path, buf.Bytes(), 0o644))
}
