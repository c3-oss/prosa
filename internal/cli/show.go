package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"database/sql"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/store"
)

func newShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <session-id>",
		Short: "Print the raw JSONL of a session",
		Long: "Reads the preserved raw JSONL file from the local store and copies " +
			"its bytes to stdout. The raw is already JSONL; --json is a no-op.",
		Args: cobra.ExactArgs(1),
		RunE: runShow,
	}
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
	defer s.Close()

	sess, err := s.GetSession(ctx, args[0])
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("session %s not found", args[0])
		}
		return err
	}
	f, err := os.Open(sess.RawPath)
	if err != nil {
		return fmt.Errorf("open raw %s: %w", sess.RawPath, err)
	}
	defer f.Close()
	_, err = io.Copy(os.Stdout, f)
	return err
}
