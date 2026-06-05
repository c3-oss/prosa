package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/cli/spinner"
	"github.com/c3-oss/prosa/internal/device"
	"github.com/c3-oss/prosa/internal/importers/antigravity"
	"github.com/c3-oss/prosa/internal/importers/claudecode"
	"github.com/c3-oss/prosa/internal/importers/codex"
	"github.com/c3-oss/prosa/internal/importers/cursor"
	"github.com/c3-oss/prosa/internal/importers/gemini"
	"github.com/c3-oss/prosa/internal/importers/hermes"
	"github.com/c3-oss/prosa/internal/legacy"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/projectid"
	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/importer"
)

// Package-level flag holders for runSync.
var (
	legacyBundleFlag  string
	syncVerboseFlag   bool
	syncOverwriteFlag bool
)

func newSyncCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "sync",
		Short: "Scan registered agents and import new sessions into the local store",
		Long: "Walks every live importer root (~/.claude/projects, ~/.codex/sessions, " +
			"~/.cursor/chats, ~/.gemini/tmp, ~/.gemini/antigravity-cli/conversations, " +
			"~/.hermes/sessions) and imports new sessions into the local SQLite store. " +
			"Pass --legacy-bundle <path> to additionally re-ingest a legacy prosa " +
			"bundle (typically ~/.prosa) — useful as a one-shot rescue when the " +
			"legacy catalog still has source files that the live tools have since " +
			"deleted. " +
			"Pass --overwrite to force re-parse and re-upsert of every discovered " +
			"file (bypassing hash idempotency and the no_usage skip cache) and " +
			"re-push every local session to the remote even when converged; useful " +
			"after upgrading prosa to pick up new projection logic. " +
			"Use --verbose to force the plain (slog) output even in a TTY; handy " +
			"for debugging long runs where the compact spinner hides per-item detail.",
		RunE: runSync,
	}
	cmd.Flags().StringVar(&legacyBundleFlag, "legacy-bundle", "",
		"path to a legacy prosa bundle (e.g. ~/.prosa) to re-ingest before live walks")
	cmd.Flags().BoolVar(&syncVerboseFlag, "verbose", false,
		"emit one slog line per imported session even when running in a TTY")
	cmd.Flags().BoolVar(&syncOverwriteFlag, "overwrite", false,
		"force re-import of every file and re-push of every session, bypassing hash idempotency and the no_usage skip cache")
	return cmd
}

type syncJob struct {
	imp        importer.Importer
	path       string
	cleanup    func() // runs after Import; used by legacy bundle to delete decompressed temp
	legacy     bool   // marks the job as coming from --legacy-bundle for the summary
	prepareErr error  // records pre-import failures so summaries stay factual
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
	case "hermes":
		return hermes.New()
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
		antigravity.New(),
		hermes.New(),
	}

	var (
		liveWork    []syncJob
		legacyWork  []syncJob
		legacyTotal int
		tmpDir      string
		bundle      *legacy.Bundle
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
		legacyTotal = len(files)
		tmpDir, err = os.MkdirTemp("", "prosa-legacy-")
		if err != nil {
			return fmt.Errorf("create temp dir for legacy decompression: %w", err)
		}
		defer func() { _ = os.RemoveAll(tmpDir) }()

		legacyWork, err = prepareLegacyWork(ctx, bundle, files, tmpDir)
		if err != nil {
			return err
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
		legacyTotal: legacyTotal,
		bundlePath:  legacyBundleFlag,
		pushEnabled: push != nil,
	}

	opts := importer.ImportOptions{Overwrite: syncOverwriteFlag}
	interactive := !syncVerboseFlag && IsInteractive()
	if interactive {
		if err := runSyncInteractive(ctx, work, s, push, dev.ID, counts, opts); err != nil {
			return err
		}
	} else {
		if err := runSyncPlain(ctx, work, s, push, counts, opts); err != nil {
			return err
		}
		// Post-import reconcile for plain/script mode only.
		runSyncReconcile(ctx, push, dev.ID, counts, opts)
	}

	// One-shot denoise: rewrites first_prompt for any session whose
	// stored value is agent-injected boilerplate (AGENTS.md preamble,
	// <command-name>, system-reminder, …). Idempotent — runs against
	// only the affected rows and reports a count of 0 on convergence.
	counts.denoiseCleaned = runDenoisePass(ctx, s)

	if interactive {
		counts.printSummaryTTY()
	} else {
		counts.printSummary()
	}
	return nil
}

func prepareLegacyWork(ctx context.Context, bundle *legacy.Bundle, files []legacy.SourceFile, tmpDir string) ([]syncJob, error) {
	work := make([]syncJob, 0, len(files))
	for _, sf := range files {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		imp := importerByLegacyTool(sf.Tool)
		if imp == nil {
			continue
		}
		path, err := bundle.Decompress(ctx, sf, tmpDir)
		if err != nil {
			work = append(work, syncJob{
				imp:        imp,
				path:       sf.OriginalPath,
				legacy:     true,
				prepareErr: fmt.Errorf("legacy decompress %s: %w", sf.ObjectIDHex, err),
			})
			continue
		}
		p := path
		work = append(work, syncJob{
			imp:     imp,
			path:    p,
			legacy:  true,
			cleanup: func() { _ = os.Remove(p) },
		})
	}
	return work, nil
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
	denoiseCleaned                       int
	pushEnabled                          bool
	remoteUnavailable                    bool
	remoteServer                         string
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
	fmt.Fprintln(os.Stdout, "prosa sync · complete")
	fmt.Fprintln(os.Stdout)
	fmt.Fprintf(os.Stdout, "Live:     imported %d · skipped %d · errors %d\n",
		sc.liveImp, sc.liveSkip, sc.liveErr)
	if sc.legacyTotal > 0 {
		fmt.Fprintf(os.Stdout, "Legacy:   imported %d · skipped %d · errors %d (of %d catalog rows)\n",
			sc.legacyImp, sc.legacySkip, sc.legacyErr, sc.legacyTotal)
	}
	if sc.pushEnabled {
		fmt.Fprintf(os.Stdout, "Push:     sent %d · skipped %d · errors %d\n",
			sc.pushImp, sc.pushSkip, sc.pushErr)
	}
	if sc.reconcileRan {
		fmt.Fprintf(os.Stdout,
			"Catch-up: sent %d · skipped %d · errors %d  (local %d · remote %d)\n",
			sc.catchUpSent, sc.catchUpSkip, sc.catchUpErr,
			sc.localTotal, sc.remoteTotal)
	}
	if sc.denoiseCleaned > 0 {
		fmt.Fprintf(os.Stdout, "Denoise:  cleaned %d prompts\n", sc.denoiseCleaned)
	}
	if sc.remoteUnavailable {
		fmt.Fprintf(os.Stdout, "Remote:   %s\n", sc.remoteUnavailableText())
	}
	if sc.legacyTotal > 0 {
		fmt.Fprintf(os.Stdout, "\n%s\n", sc.legacySummaryText())
	}
}

func (sc *syncCounts) printSummaryTTY() {
	fmt.Fprintln(os.Stdout)
	fmt.Fprintln(os.Stdout, render.StyleHeader.Render("prosa sync · complete"))
	fmt.Fprintln(os.Stdout)
	printSummaryTTYRow("Live", "imported", sc.liveImp, sc.liveSkip, sc.liveErr, "")
	if sc.legacyTotal > 0 {
		printSummaryTTYRow("Legacy", "imported", sc.legacyImp, sc.legacySkip, sc.legacyErr,
			fmt.Sprintf("of %d catalog rows", sc.legacyTotal))
	}
	if sc.pushEnabled {
		printSummaryTTYRow("Push", "sent", sc.pushImp, sc.pushSkip, sc.pushErr, "")
	}
	if sc.reconcileRan {
		extra := fmt.Sprintf("local %d · remote %d", sc.localTotal, sc.remoteTotal)
		printSummaryTTYRow("Catch-up", "sent", sc.catchUpSent, sc.catchUpSkip, sc.catchUpErr, extra)
	}
	if sc.denoiseCleaned > 0 {
		fmt.Fprintf(
			os.Stdout, "%s %s  %s %d %s\n",
			render.StyleRail.Render("│"),
			render.StyleHeader.Render("Denoise"),
			render.StyleSuccess.Render("cleaned"),
			sc.denoiseCleaned,
			render.StyleMuted.Render("prompts"),
		)
	}
	if sc.remoteUnavailable {
		fmt.Fprintf(
			os.Stdout, "%s %s  %s\n",
			render.StyleRail.Render("│"),
			render.StyleHeader.Render("Remote"),
			render.StyleMuted.Render(sc.remoteUnavailableText()),
		)
	}
	if sc.legacyTotal > 0 {
		fmt.Fprintln(os.Stdout)
		fmt.Fprintf(
			os.Stdout, "%s %s\n",
			render.StyleRail.Render("│"),
			render.StyleMuted.Render(sc.legacySummaryText()),
		)
	}
}

func (sc *syncCounts) legacySummaryText() string {
	if sc.legacyErr > 0 {
		return fmt.Sprintf("Legacy bundle partially mirrored in the prosa store: %s", sc.bundlePath)
	}
	return fmt.Sprintf("Legacy bundle mirrored in the prosa store: %s", sc.bundlePath)
}

func printSummaryTTYRow(label, primaryVerb string, primary, skipped, errs int, extra string) {
	line := fmt.Sprintf(
		"%s %s %s %d · %s %d · %s %d",
		render.StyleRail.Render("│"),
		render.StyleMuted.Render(padSummaryLabel(label)),
		render.StyleSuccess.Render(primaryVerb), primary,
		render.StyleSkipped.Render("skipped"), skipped,
		render.StyleError.Render("errors"), errs,
	)
	if extra != "" {
		line += " · " + render.StyleMuted.Render(extra)
	}
	fmt.Fprintln(os.Stdout, line)
}

func padSummaryLabel(label string) string {
	if len(label) >= 9 {
		return label
	}
	return label + strings.Repeat(" ", 9-len(label))
}

// runSyncInteractive drives the two-phase Bubble Tea checklist (local
// import + optional remote catch-up). The driver goroutine runs
// sequentially and feeds updates into a channel the Bubble Tea program
// consumes. Reconcile runs inside the same program lifetime so the remote
// row can animate.
func runSyncInteractive(
	ctx context.Context,
	work []syncJob,
	sink importer.Sink,
	push *pusher,
	deviceID string,
	counts *syncCounts,
	opts importer.ImportOptions,
) error {
	items := make([]spinner.Item, len(work))
	for i, w := range work {
		label := w.imp.Name()
		if w.legacy {
			label = "legacy/" + label
		}
		items[i] = spinner.Item{Agent: label, Path: w.path}
	}
	updates := make(chan spinner.Update, len(work)*2+16)

	// Suppress the catch-up phase's structured logging while Bubble Tea
	// repaints in place; concurrent writes (e.g. reconcile: catching up)
	// desync the cursor and orphan frames. We scope this to the pusher's
	// logger rather than mutating the process-global slog default, which
	// would silently swallow every other component's logs for the duration.
	if push != nil {
		push.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}

	go func() {
		defer close(updates)
		send := func(u spinner.Update) bool {
			select {
			case <-ctx.Done():
				return false
			case updates <- u:
				return true
			}
		}

		if !send(spinner.Update{
			Phase: spinner.PhaseLocal,
			Begin: true,
			Total: len(work),
			Verb:  "importing",
		}) {
			return
		}

		for i, w := range work {
			if !send(spinner.Update{Phase: spinner.PhaseLocal, Index: i, Started: true}) {
				return
			}
			var res importer.ImportResult
			err := w.prepareErr
			if err == nil {
				res, err = w.imp.Import(ctx, w.path, sink, opts)
			}
			if w.prepareErr == nil && w.cleanup != nil {
				w.cleanup()
			}
			counts.record(w, res, err)
			if push != nil && err == nil && !res.Skipped {
				counts.recordPush(push.pushSession(ctx, res.SessionID))
			}
			if !send(spinner.Update{
				Phase:   spinner.PhaseLocal,
				Index:   i,
				Skipped: res.Skipped,
				Err:     err,
			}) {
				return
			}
		}

		if !send(spinner.Update{Phase: spinner.PhaseLocal, Done: true, Verb: "imported"}) {
			return
		}

		if push == nil {
			return
		}

		if !send(spinner.Update{
			Phase: spinner.PhaseRemote,
			Begin: true,
			Verb:  "reconciling",
		}) {
			return
		}

		var rc reconcileCounts
		var reconcileErr error
		hooks := reconcileHooks{
			onPlan: func(total int) {
				send(spinner.Update{
					Phase:    spinner.PhaseRemote,
					SetTotal: true,
					Total:    total,
				})
			},
			onStep: func(done, total int, sid string, outcome pushOutcome) {
				u := spinner.Update{
					Phase: spinner.PhaseRemote,
					Active: &spinner.Item{
						Agent: "remote",
						Path:  sid,
					},
				}
				switch outcome {
				case pushAlreadyHashed, pushSkippedNoUsage, pushSkippedRemoteUnavailable:
					u.Skipped = true
				case pushFailed:
					u.Err = errors.New("push failed")
				default:
					// pushImported counts as done (sent).
				}
				send(u)
			},
		}
		rc, reconcileErr = reconcileWithServer(ctx, push, deviceID, opts, hooks)
		foldReconcile(counts, rc, reconcileErr, push)

		extra := fmt.Sprintf("local %d · remote %d", rc.localTotal, rc.remoteTotal)
		if push.remoteUnavailable || isRemoteUnavailable(reconcileErr) {
			send(spinner.Update{
				Phase:       spinner.PhaseRemote,
				Done:        true,
				Unavailable: true,
				Verb:        "unavailable",
				Extra:       extra,
			})
			return
		}
		send(spinner.Update{
			Phase: spinner.PhaseRemote,
			Done:  true,
			Verb:  "sent",
			Extra: extra,
		})
	}()

	spinnerOpts := spinner.Options{
		Title:         "prosa sync · local store",
		Found:         syncFoundSummary(items),
		RemoteEnabled: push != nil,
	}
	if counts.legacyTotal > 0 {
		spinnerOpts.Banner = fmt.Sprintf("legacy bundle: %s", legacyBundleFlag)
	}
	fmt.Fprintln(os.Stdout)
	if err := spinner.Run(ctx, items, updates, spinnerOpts); err != nil && !errors.Is(err, context.Canceled) {
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
func runSyncPlain(ctx context.Context, work []syncJob, sink importer.Sink, push *pusher, counts *syncCounts, opts importer.ImportOptions) error {
	for _, w := range work {
		start := time.Now()
		var res importer.ImportResult
		err := w.prepareErr
		if err == nil {
			res, err = w.imp.Import(ctx, w.path, sink, opts)
		}
		if w.prepareErr == nil && w.cleanup != nil {
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
	case pushAlreadyHashed, pushSkippedNoUsage:
		sc.pushSkip++
	case pushFailed:
		sc.pushErr++
	}
}

func (sc *syncCounts) recordRemoteUnavailable(push *pusher) {
	if push == nil || !push.remoteUnavailable {
		return
	}
	sc.remoteUnavailable = true
	sc.remoteServer = push.server
}

func (sc *syncCounts) remoteUnavailableText() string {
	server := sc.remoteServer
	if server == "" {
		server = "the configured server"
	}
	return fmt.Sprintf("server unavailable at %s; local import is saved. Run `prosa sync` again when it is back.", server)
}
