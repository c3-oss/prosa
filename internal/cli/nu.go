package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/store"
)

// runNu implements the bare `prosa` invocation: list sessions in the
// configured window. Default window is 7 days; override with --last.
func runNu(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}

	window, err := ParseLast(g.Last)
	if err != nil {
		return fmt.Errorf("--last: %w", err)
	}
	storePath, err := paths.StorePath()
	if err != nil {
		return err
	}
	s, err := store.Open(ctx, storePath)
	if err != nil {
		return err
	}
	defer s.Close()

	now := time.Now().UTC()
	sessions, err := s.ListSessionsByRange(ctx, now.Add(-window), now)
	if err != nil {
		return err
	}

	if g.JSON {
		enc := json.NewEncoder(os.Stdout)
		for i := range sessions {
			if err := enc.Encode(sessions[i]); err != nil {
				return err
			}
		}
		return nil
	}

	if len(sessions) == 0 {
		fmt.Fprintf(os.Stdout, "no sessions in the last %s\n", g.Last)
		return nil
	}
	return render.Timeline(os.Stdout, sessions, now, IsInteractive())
}
