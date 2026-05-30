package cli

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/cli/spinner"
	"github.com/c3-oss/prosa/internal/importers/claudecode"
	"github.com/c3-oss/prosa/internal/importers/codex"
	"github.com/c3-oss/prosa/internal/importers/cursor"
	"github.com/c3-oss/prosa/internal/importers/gemini"
	"github.com/c3-oss/prosa/internal/legacy"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/importer"
)

// legacyBundleFlag holds the value of --legacy-bundle for runSync.
var (
	legacyBundleFlag string
	syncVerboseFlag  bool
)

func newSyncCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "sync",
		Short: "Scan registered agents and import new sessions into the local store",
		Long: "Walks every live importer root (~/.claude/projects, ~/.codex/sessions, " +
			"~/.gemini/tmp) and imports new sessions into the local SQLite store. " +
			"Pass --legacy-bundle <path> to additionally re-ingest a prosa v1 bundle " +
			"(typically ~/.prosa) — useful as a one-shot rescue after the v3 cutover " +
			"when the v1 catalog still has source files that the live tools have " +
			"since deleted. " +
			"Use --verbose to force the plain (slog) output even in a TTY; handy " +
			"for debugging long runs where the compact spinner hides per-item detail.",
		RunE: runSync,
	}
	cmd.Flags().StringVar(&legacyBundleFlag, "legacy-bundle", "",
		"path to a prosa v1 bundle (e.g. ~/.prosa) to re-ingest before live walks")
	cmd.Flags().BoolVar(&syncVerboseFlag, "verbose", false,
		"emit one slog line per imported session even when running in a TTY")
	return cmd
}

type syncJob struct {
	imp     importer.Importer
	path    string
	cleanup func() // runs after Import; used by legacy bundle to delete decompressed temp
	legacy  bool   // marks the job as coming from --legacy-bundle for the summary
}

// importerByLegacyTool maps the v1 bundle's source_tool string to the
// matching v3 importer instance. Returns nil for unknown tools (silently
// skipped by the caller — keeps the iterator tolerant of future v1 tools
// without breaking the import run).
func importerByLegacyTool(tool string) importer.Importer {
	switch tool {
	case "claude":
		return claudecode.New()
	case "codex":
		return codex.New()
	case "cursor":
		return cursor.New()
	case "gemini":
		return gemini.New()
	}
	return nil
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
	defer func() { _ = s.Close() }()

	imps := []importer.Importer{
		claudecode.New(),
		codex.New(),
		cursor.New(),
		gemini.New(),
	}

	var (
		liveWork   []syncJob
		legacyWork []syncJob
		tmpDir     string
		bundle     *legacy.Bundle
	)
	for _, imp := range imps {
		for _, root := range imp.DefaultRoots() {
			ps, err := imp.Walk(ctx, root)
			if err != nil {
				slog.Warn("walk failed", "agent", imp.Name(), "root", root, "err", err)
				continue
			}
			for _, p := range ps {
				liveWork = append(liveWork, syncJob{imp: imp, path: p})
			}
		}
	}

	if legacyBundleFlag != "" {
		bundle, err = legacy.Open(legacyBundleFlag)
		if err != nil {
			return fmt.Errorf("open legacy bundle: %w", err)
		}
		defer func() { _ = bundle.Close() }()

		files, err := bundle.SourceFiles(ctx)
		if err != nil {
			return fmt.Errorf("read legacy bundle catalog: %w", err)
		}
		tmpDir, err = os.MkdirTemp("", "prosa-legacy-")
		if err != nil {
			return fmt.Errorf("create temp dir for legacy decompression: %w", err)
		}
		defer func() { _ = os.RemoveAll(tmpDir) }()

		for _, sf := range files {
			imp := importerByLegacyTool(sf.Tool)
			if imp == nil {
				continue
			}
			path, err := bundle.Decompress(ctx, sf, tmpDir)
			if err != nil {
				slog.Warn("legacy decompress failed",
					"tool", sf.Tool, "oid", sf.ObjectIDHex, "err", err)
				continue
			}
			p := path
			legacyWork = append(legacyWork, syncJob{
				imp:     imp,
				path:    p,
				legacy:  true,
				cleanup: func() { _ = os.Remove(p) },
			})
		}
	}

	work := append(legacyWork, liveWork...)
	if len(work) == 0 {
		fmt.Fprintln(os.Stdout, "No sessions found.")
		return nil
	}

	if !syncVerboseFlag && IsInteractive() {
		return runSyncTTY(ctx, work, s, len(legacyWork))
	}
	return runSyncPlain(ctx, work, s, len(legacyWork))
}

// syncCounts breaks results down by live vs legacy so the final banner can
// nudge the user to free up the bundle directory.
type syncCounts struct {
	liveImp, liveSkip, liveErr       int
	legacyImp, legacySkip, legacyErr int
	legacyTotal                      int
	bundlePath                       string
}

func (sc *syncCounts) record(w syncJob, res importer.ImportResult, err error) {
	switch {
	case err != nil:
		if w.legacy {
			sc.legacyErr++
		} else {
			sc.liveErr++
		}
	case res.Skipped:
		if w.legacy {
			sc.legacySkip++
		} else {
			sc.liveSkip++
		}
	default:
		if w.legacy {
			sc.legacyImp++
		} else {
			sc.liveImp++
		}
	}
}

func (sc *syncCounts) printSummary() {
	fmt.Fprintf(os.Stdout, "Live:    imported %d, skipped %d, errors %d\n",
		sc.liveImp, sc.liveSkip, sc.liveErr)
	if sc.legacyTotal > 0 {
		fmt.Fprintf(os.Stdout, "Legacy:  imported %d, skipped %d, errors %d (of %d catalog rows)\n",
			sc.legacyImp, sc.legacySkip, sc.legacyErr, sc.legacyTotal)
		fmt.Fprintf(os.Stdout,
			"\nLegacy bundle is now mirrored in the v3 store. You can remove %s when ready.\n",
			sc.bundlePath)
	}
}

// runSyncTTY drives the Bubble Tea progress display. The importer
// goroutine runs sequentially (SQLite writer-lock makes parallelism
// counter-productive at small N) and feeds updates into a channel the
// Bubble Tea program consumes.
func runSyncTTY(ctx context.Context, work []syncJob, sink importer.Sink, legacyTotal int) error {
	items := make([]spinner.Item, len(work))
	for i, w := range work {
		label := w.imp.Name()
		if w.legacy {
			label = "legacy/" + label
		}
		items[i] = spinner.Item{Agent: label, Path: w.path}
	}
	updates := make(chan spinner.Update, len(work))
	counts := &syncCounts{legacyTotal: legacyTotal, bundlePath: legacyBundleFlag}

	go func() {
		defer close(updates)
		for i, w := range work {
			res, err := w.imp.Import(ctx, w.path, sink)
			if w.cleanup != nil {
				w.cleanup()
			}
			counts.record(w, res, err)
			select {
			case <-ctx.Done():
				return
			case updates <- spinner.Update{Index: i, Skipped: res.Skipped, Err: err}:
			}
		}
	}()
	opts := spinner.Options{
		Title: "prosa sync",
	}
	if legacyTotal > 0 {
		opts.Banner = fmt.Sprintf("legacy bundle: %s", legacyBundleFlag)
	}
	if err := spinner.Run(ctx, items, updates, opts); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	counts.printSummary()
	return nil
}

// runSyncPlain is the non-TTY fallback used by LaunchAgent/cron and by
// the --verbose flag. One structured log line per session, plus a
// summary block on stdout at the end. No escape codes, no alt-screen.
func runSyncPlain(ctx context.Context, work []syncJob, sink importer.Sink, legacyTotal int) error {
	counts := &syncCounts{legacyTotal: legacyTotal, bundlePath: legacyBundleFlag}
	for _, w := range work {
		start := time.Now()
		res, err := w.imp.Import(ctx, w.path, sink)
		if w.cleanup != nil {
			w.cleanup()
		}
		dur := time.Since(start)
		counts.record(w, res, err)
		switch {
		case err != nil:
			slog.Error("import failed",
				"agent", w.imp.Name(), "path", w.path, "legacy", w.legacy, "err", err)
		case res.Skipped:
			slog.Info("imported",
				"agent", w.imp.Name(), "session", res.SessionID, "status", "skipped",
				"legacy", w.legacy, "dur", dur)
		default:
			slog.Info("imported",
				"agent", w.imp.Name(), "session", res.SessionID, "status", "done",
				"legacy", w.legacy, "dur", dur)
		}
	}
	counts.printSummary()
	return nil
}
