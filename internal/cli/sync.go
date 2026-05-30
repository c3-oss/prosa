package cli

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/cli/spinner"
	"github.com/c3-oss/prosa/internal/importers/claudecode"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/importer"
)

func newSyncCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "sync",
		Short: "Scan registered agents and import new sessions into the local store",
		RunE:  runSync,
	}
}

type syncJob struct {
	imp  importer.Importer
	path string
}

func runSync(cmd *cobra.Command, _ []string) error {
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

	imps := []importer.Importer{claudecode.New()}

	var work []syncJob
	for _, imp := range imps {
		for _, root := range imp.DefaultRoots() {
			ps, err := imp.Walk(ctx, root)
			if err != nil {
				slog.Warn("walk failed", "agent", imp.Name(), "root", root, "err", err)
				continue
			}
			for _, p := range ps {
				work = append(work, syncJob{imp: imp, path: p})
			}
		}
	}

	if len(work) == 0 {
		fmt.Fprintln(os.Stdout, "No sessions found.")
		return nil
	}

	if IsInteractive() {
		return runSyncTTY(ctx, work, s)
	}
	return runSyncPlain(ctx, work, s)
}

// runSyncTTY drives the Bubble Tea progress display. The importer
// goroutine runs sequentially (SQLite writer-lock makes parallelism
// counter-productive at small N) and feeds updates into a channel the
// Bubble Tea program consumes.
func runSyncTTY(ctx context.Context, work []syncJob, sink importer.Sink) error {
	items := make([]spinner.Item, len(work))
	for i, w := range work {
		items[i] = spinner.Item{Agent: w.imp.Name(), Path: w.path}
	}
	updates := make(chan spinner.Update, len(work))
	go func() {
		defer close(updates)
		for i, w := range work {
			res, err := w.imp.Import(ctx, w.path, sink)
			select {
			case <-ctx.Done():
				return
			case updates <- spinner.Update{Index: i, Skipped: res.Skipped, Err: err}:
			}
		}
	}()
	return spinner.Run(ctx, items, updates)
}

// runSyncPlain is the non-TTY fallback used by LaunchAgent/cron. One
// structured log line per session, plus a summary line on stdout at the
// end. No escape codes, no alt-screen.
func runSyncPlain(ctx context.Context, work []syncJob, sink importer.Sink) error {
	var imported, skipped, errs int
	for _, w := range work {
		start := time.Now()
		res, err := w.imp.Import(ctx, w.path, sink)
		dur := time.Since(start)
		switch {
		case err != nil:
			errs++
			slog.Error("import failed", "agent", w.imp.Name(), "path", w.path, "err", err)
		case res.Skipped:
			skipped++
			slog.Info("imported", "agent", w.imp.Name(), "session", res.SessionID, "status", "skipped", "dur", dur)
		default:
			imported++
			slog.Info("imported", "agent", w.imp.Name(), "session", res.SessionID, "status", "done", "dur", dur)
		}
	}
	fmt.Fprintf(os.Stdout, "Imported %d, skipped %d, errors %d\n", imported, skipped, errs)
	return nil
}
