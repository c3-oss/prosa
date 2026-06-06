package cli

import (
	"io"
	"testing"

	"github.com/spf13/cobra"
	"github.com/stretchr/testify/require"
)

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
