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
	"github.com/c3-oss/prosa/pkg/session"
)

var showRawFlag bool

func newShowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "show <session-id>",
		Short: "Print a session's preserved raw transcript",
		Long: "Prints the raw JSONL bytes of a session. In an interactive terminal, " +
			"a short session/agent/raw preface is also written to stderr so the " +
			"output can be piped (`prosa show <id> | jq`) without polluting stdout. " +
			"--raw and --json omit the preface entirely.",
		Args: cobra.ExactArgs(1),
		RunE: runShow,
	}
	cmd.Flags().BoolVar(&showRawFlag, "raw", false,
		"omit the stderr preface even when stdout is a TTY")
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
	if IsInteractive() && !showRawFlag && !g.JSON {
		writeShowPreface(os.Stderr, sess)
	}
	return copyRaw(sess.RawPath)
}

// writeShowPreface emits the 3-line audit preface (session / agent /
// raw path) per the rendering contract §Show Raw. Goes to stderr so
// stdout stays the raw bytes.
func writeShowPreface(w io.Writer, s session.Session) {
	fmt.Fprintf(w, "session  %s\n", render.StyleAccent.Render(s.ID))
	fmt.Fprintf(w, "agent    %s\n", render.StyleAgent.Render(s.Agent))
	fmt.Fprintf(w, "raw      %s\n", render.StyleMuted.Render(s.RawPath))
	fmt.Fprintln(w)
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
