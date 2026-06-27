package cli

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"
	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/cli/rpc"
)

type fakeSearchSessions struct {
	prosav1connect.UnimplementedSessionsServiceHandler
	got *prosav1.SearchRequest
}

func (f *fakeSearchSessions) Search(_ context.Context, req *connect.Request[prosav1.SearchRequest]) (*connect.Response[prosav1.SearchResponse], error) {
	f.got = req.Msg
	return connect.NewResponse(&prosav1.SearchResponse{}), nil
}

func TestRunSearchRemoteAppliesExplicitProject(t *testing.T) {
	originalFlags := g
	t.Cleanup(func() {
		g = originalFlags
	})
	tmp := t.TempDir()
	t.Setenv("PROSA_CONFIG_HOME", filepath.Join(tmp, "config"))
	t.Setenv("PROSA_HOME", filepath.Join(tmp, "data"))

	sessions := &fakeSearchSessions{}
	mux := http.NewServeMux()
	sessionsPath, sessionsHandler := prosav1connect.NewSessionsServiceHandler(sessions)
	mux.Handle(sessionsPath, sessionsHandler)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	require.NoError(t, rpc.SaveAuth(rpc.AuthFile{
		Server:   server.URL,
		DeviceID: "device-a",
		Token:    "token",
	}))

	g = globalFlags{
		JSON:    true,
		Project: "prosa",
		Agent:   "codex",
		Device:  "device-a",
		Profile: "work",
	}
	now := time.Date(2026, 6, 22, 13, 0, 0, 0, time.UTC)
	w := Window{Since: now.Add(-24 * time.Hour), Until: now}

	var runErr error
	stdout, _ := captureStdoutStderr(t, func() {
		runErr = runSearchRemote(context.Background(), "security issues", w, 7)
	})
	require.NoError(t, runErr)
	require.Empty(t, stdout)
	require.NotNil(t, sessions.got)
	require.Equal(t, "security issues", sessions.got.Query)
	require.Equal(t, int32(7), sessions.got.Limit)
	require.Equal(t, "prosa", sessions.got.ProjectMatch)
	require.Empty(t, sessions.got.ProjectRemote)
	require.Empty(t, sessions.got.ProjectMarker)
	require.Equal(t, "codex", sessions.got.Agent)
	require.Equal(t, "device-a", sessions.got.DeviceName)
	require.Equal(t, "work", sessions.got.Profile)
}

func TestSearchLimitResolution(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want int
	}{
		{
			name: "default",
			args: []string{"search", "quantum"},
			want: defaultSearchLimit,
		},
		{
			name: "root flag before subcommand",
			args: []string{"--limit", "5", "search", "quantum"},
			want: 5,
		},
		{
			name: "local search flag after subcommand",
			args: []string{"search", "--limit", "6", "quantum"},
			want: 6,
		},
		{
			name: "local search flag wins",
			args: []string{"--limit", "5", "search", "--limit", "6", "quantum"},
			want: 6,
		},
		{
			name: "explicit zero keeps search default",
			args: []string{"--limit", "0", "search", "quantum"},
			want: defaultSearchLimit,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			originalFlags := g
			originalSearchLimit := searchLimit
			t.Cleanup(func() {
				g = originalFlags
				searchLimit = originalSearchLimit
			})

			cmd, searchCmd := newTestSearchLimitCmd(t)
			searchCmd.RunE = func(cmd *cobra.Command, _ []string) error {
				got, err := effectiveSearchLimit(cmd)
				require.NoError(t, err)
				require.Equal(t, c.want, got)
				return nil
			}
			cmd.SetArgs(c.args)

			require.NoError(t, cmd.Execute())
		})
	}
}

func TestSearchLimitRejectsNegative(t *testing.T) {
	cases := [][]string{
		{"--limit", "-1", "search", "quantum"},
		{"search", "--limit", "-1", "quantum"},
	}
	for _, args := range cases {
		t.Run(args[0]+" "+args[1], func(t *testing.T) {
			originalFlags := g
			originalSearchLimit := searchLimit
			t.Cleanup(func() {
				g = originalFlags
				searchLimit = originalSearchLimit
			})

			cmd, searchCmd := newTestSearchLimitCmd(t)
			searchCmd.RunE = func(cmd *cobra.Command, _ []string) error {
				_, err := effectiveSearchLimit(cmd)
				return err
			}
			cmd.SetArgs(args)

			require.ErrorContains(t, cmd.Execute(), "--limit must be >= 0")
		})
	}
}

func newTestSearchLimitCmd(t *testing.T) (*cobra.Command, *cobra.Command) {
	t.Helper()

	cmd := newRootCmd()
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	for _, sub := range cmd.Commands() {
		if sub.Name() == "search" {
			return cmd, sub
		}
	}
	t.Fatal("search command not registered")
	return nil, nil
}
