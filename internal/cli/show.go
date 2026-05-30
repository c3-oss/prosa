package cli

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/store"
)

var showRawFlag bool

func newShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show <session-id>",
		Short: "Show a session",
		Long: "In an interactive terminal, renders a compact human view of the session. " +
			"Use --raw, --json, or pipe stdout to copy the preserved raw bytes exactly.",
		Args: cobra.ExactArgs(1),
		RunE: runShow,
	}
	cmd.Flags().BoolVar(&showRawFlag, "raw", false, "print preserved raw bytes exactly")
	return cmd
}

func runShow(cmd *cobra.Command, args []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	storePath, err := paths.StorePath()
	if err != nil {
		return err
	}
	s, err := store.Open(ctx, storePath)
	if err != nil {
		return err
	}
	defer func() { _ = s.Close() }()

	sess, err := s.GetSession(ctx, args[0])
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("session %s not found", args[0])
		}
		return err
	}
	if showRawFlag || g.JSON || !IsInteractive() {
		return copyRaw(sess.RawPath)
	}

	tools, err := s.GetSessionTools(ctx, sess.ID)
	if err != nil {
		return err
	}
	turns, err := s.GetTurns(ctx, sess.ID)
	if err != nil {
		return err
	}
	return render.ShowSession(os.Stdout, render.SessionDetail{
		Session: sess,
		Tools:   tools,
		Turns:   turns,
		Width:   TerminalWidth(),
	})
}

func copyRaw(rawPath string) error {
	f, err := os.Open(rawPath)
	if err != nil {
		return fmt.Errorf("open raw %s: %w", rawPath, err)
	}
	defer f.Close()
	_, err = io.Copy(os.Stdout, f)
	return err
}
