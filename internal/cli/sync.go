package cli

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/cli/spinner"
	"github.com/c3-oss/prosa/internal/device"
	"github.com/c3-oss/prosa/internal/importers/claudecode"
	"github.com/c3-oss/prosa/internal/importers/codex"
	"github.com/c3-oss/prosa/internal/importers/cursor"
	"github.com/c3-oss/prosa/internal/importers/gemini"
	"github.com/c3-oss/prosa/internal/legacy"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/projectid"
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

	// Resolve this device's identity once and write it through the store
	// so every sessions.device_id we insert below references a real row.
	// Also migrate any session rows that were inserted under the seed
	// `'local'` device id (the v1 bundle restore path) to the real
	// fingerprint — those sessions necessarily came from this machine.
	dev := store.Device{
		ID:              device.IDOnce(),
		Hostname:        device.Hostname(),
		MachineID:       device.MachineID(),
		FriendlyName:    device.FriendlyName(),
		FingerprintedAt: time.Now().UTC(),
	}
	if err := s.UpsertDevice(ctx, dev); err != nil {
		return fmt.Errorf("upsert device: %w", err)
	}
	if n, err := s.RebindLocalSessions(ctx, dev.ID); err != nil {
		return fmt.Errorf("rebind 'local' sessions to %s: %w", dev.ID, err)
	} else if n > 0 {
		slog.Info("rebound legacy 'local' sessions to fingerprint",
			"device_id", dev.ID, "rows", n)
	}

	// One-shot project identity backfill: for every distinct cwd that
	// still has NULL project_remote/marker, ask projectid.Resolve to
	// derive the canonical identity. Cwds that no longer exist on this
	// machine (legacy bundle rows) silently skip; the rest get
	// retro-tagged so the timeline auto-filter and `prosa analytics
	// projects` find them.
	if err := backfillProjectIdentity(ctx, s); err != nil {
		slog.Warn("project identity backfill failed", "err", err)
	}

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

	push, err := loadPusher(s)
	if err != nil {
		slog.Warn("push disabled (auth file unreadable)", "err", err)
	}

	counts := &syncCounts{
		legacyTotal: len(legacyWork),
		bundlePath:  legacyBundleFlag,
		pushEnabled: push != nil,
	}

	if !syncVerboseFlag && IsInteractive() {
		if err := runSyncTTY(ctx, work, s, push, counts); err != nil {
			return err
		}
	} else {
		if err := runSyncPlain(ctx, work, s, push, counts); err != nil {
			return err
		}
	}

	// Post-import: manifest-driven reconcile. No-op when push is nil
	// (no auth.json) or when ctx was cancelled mid-import. Sequential
	// pushes; takes the same SQLite reader so it slots in cleanly after
	// the importer goroutine has exited.
	runSyncReconcile(ctx, push, dev.ID, counts)

	counts.printSummary()
	return nil
}

// backfillProjectIdentity iterates every distinct project_path lacking
// identity columns, asks projectid.Resolve, and writes back remote /
// marker via store.FillProjectIdentity. Each path is touched once.
func backfillProjectIdentity(ctx context.Context, s *store.Store) error {
	paths, err := s.DistinctProjectPathsNeedingIdentity(ctx)
	if err != nil {
		return err
	}
	var remoteRows, markerRows int64
	for _, p := range paths {
		id := projectid.Resolve(p)
		remote := ""
		if id.Remote != nil {
			remote = *id.Remote
		}
		marker := ""
		if id.Marker != nil {
			marker = *id.Marker
		}
		if remote == "" && marker == "" {
			continue
		}
		rn, mn, err := s.FillProjectIdentity(ctx, p, remote, marker)
		if err != nil {
			slog.Warn("project identity fill failed", "path", p, "err", err)
			continue
		}
		remoteRows += rn
		markerRows += mn
	}
	if remoteRows > 0 || markerRows > 0 {
		slog.Info("project identity backfill applied",
			"remote_rows", remoteRows, "marker_rows", markerRows, "paths_scanned", len(paths))
	}
	return nil
}

// syncCounts breaks results down by live vs legacy so the final banner can
// nudge the user to free up the bundle directory. The pushImp/Skip/Err
// trio counts the inline push that runs right after each Import; the
// catchUp* trio counts the post-import manifest-driven reconcile that
// makes the server converge to the local set even for sessions imported
// long before the auth.json existed.
type syncCounts struct {
	liveImp, liveSkip, liveErr           int
	legacyImp, legacySkip, legacyErr     int
	pushImp, pushSkip, pushErr           int
	catchUpSent, catchUpSkip, catchUpErr int
	localTotal, remoteTotal              int
	pushEnabled                          bool
	reconcileRan                         bool
	legacyTotal                          int
	bundlePath                           string
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
	fmt.Fprintf(os.Stdout, "Live:     imported %d, skipped %d, errors %d\n",
		sc.liveImp, sc.liveSkip, sc.liveErr)
	if sc.legacyTotal > 0 {
		fmt.Fprintf(os.Stdout, "Legacy:   imported %d, skipped %d, errors %d (of %d catalog rows)\n",
			sc.legacyImp, sc.legacySkip, sc.legacyErr, sc.legacyTotal)
	}
	if sc.pushEnabled {
		fmt.Fprintf(os.Stdout, "Push:     sent %d, skipped %d, errors %d\n",
			sc.pushImp, sc.pushSkip, sc.pushErr)
	}
	if sc.reconcileRan {
		fmt.Fprintf(os.Stdout,
			"Catch-up: sent %d, skipped %d, errors %d  (local %d, remote %d)\n",
			sc.catchUpSent, sc.catchUpSkip, sc.catchUpErr,
			sc.localTotal, sc.remoteTotal)
	}
	if sc.legacyTotal > 0 {
		fmt.Fprintf(os.Stdout,
			"\nLegacy bundle is now mirrored in the v3 store. You can remove %s when ready.\n",
			sc.bundlePath)
	}
}

// runSyncTTY drives the Bubble Tea progress display. The importer
// goroutine runs sequentially (SQLite writer-lock makes parallelism
// counter-productive at small N) and feeds updates into a channel the
// Bubble Tea program consumes. counts is owned by the orchestrator
// (runSync) so the reconcile + summary phases share the same struct.
func runSyncTTY(ctx context.Context, work []syncJob, sink importer.Sink, push *pusher, counts *syncCounts) error {
	items := make([]spinner.Item, len(work))
	for i, w := range work {
		label := w.imp.Name()
		if w.legacy {
			label = "legacy/" + label
		}
		items[i] = spinner.Item{Agent: label, Path: w.path}
	}
	updates := make(chan spinner.Update, len(work)*2)

	go func() {
		defer close(updates)
		for i, w := range work {
			select {
			case <-ctx.Done():
				return
			case updates <- spinner.Update{Index: i, Started: true}:
			}
			res, err := w.imp.Import(ctx, w.path, sink)
			if w.cleanup != nil {
				w.cleanup()
			}
			counts.record(w, res, err)
			// Push the just-imported session unless the Import itself
			// failed; legacy + live both go up.
			if push != nil && err == nil && !res.Skipped {
				counts.recordPush(push.pushSession(ctx, res.SessionID))
			}
			select {
			case <-ctx.Done():
				return
			case updates <- spinner.Update{Index: i, Skipped: res.Skipped, Err: err}:
			}
		}
	}()
	opts := spinner.Options{
		Title: "prosa sync · local store",
		Found: syncFoundSummary(items),
	}
	if counts.legacyTotal > 0 {
		opts.Banner = fmt.Sprintf("legacy bundle: %s", legacyBundleFlag)
	}
	if err := spinner.Run(ctx, items, updates, opts); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}

func syncFoundSummary(items []spinner.Item) string {
	if len(items) == 0 {
		return ""
	}
	counts := map[string]int{}
	var order []string
	for _, item := range items {
		if _, ok := counts[item.Agent]; !ok {
			order = append(order, item.Agent)
		}
		counts[item.Agent]++
	}
	parts := make([]string, 0, len(order))
	for _, agent := range order {
		parts = append(parts, fmt.Sprintf("%s %d", agent, counts[agent]))
	}
	return strings.Join(parts, " · ")
}

// runSyncPlain is the non-TTY fallback used by LaunchAgent/cron and by
// the --verbose flag. One structured log line per session; the summary
// block is printed by the orchestrator (runSync) after the reconcile
// phase. No escape codes, no alt-screen.
func runSyncPlain(ctx context.Context, work []syncJob, sink importer.Sink, push *pusher, counts *syncCounts) error {
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
			if push != nil {
				outcome, pushErr := push.pushSession(ctx, res.SessionID)
				counts.recordPush(outcome, pushErr)
				logPush(res.SessionID, outcome, pushErr)
			}
		}
	}
	return nil
}

// recordPush updates the syncCounts based on the push outcome. Wraps
// the outcome-to-counter mapping so both runSyncTTY and runSyncPlain
// share the same routing logic.
func (sc *syncCounts) recordPush(outcome pushOutcome, err error) {
	if err != nil && outcome != pushFailed {
		outcome = pushFailed
	}
	switch outcome {
	case pushImported:
		sc.pushImp++
	case pushAlreadyHashed:
		sc.pushSkip++
	case pushFailed:
		sc.pushErr++
	}
}
