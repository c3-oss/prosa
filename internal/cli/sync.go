package cli

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/device"
	"github.com/c3-oss/prosa/internal/importers/claudecode"
	"github.com/c3-oss/prosa/internal/importers/codex"
	"github.com/c3-oss/prosa/internal/importers/cursor"
	"github.com/c3-oss/prosa/internal/importers/gemini"
	"github.com/c3-oss/prosa/internal/importers/hermes"
	"github.com/c3-oss/prosa/internal/legacy"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/profiles"
	"github.com/c3-oss/prosa/internal/projectid"
	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/importer"
)

var (
	legacyBundleFlag  string
	syncVerboseFlag   bool
	syncOverwriteFlag bool
)

func newSyncCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "sync",
		Short: "Import new sessions from installed agents into the local store",
		RunE:  runSync,
	}
	cmd.Flags().StringVar(&legacyBundleFlag, "legacy-bundle", "",
		"path to a legacy prosa bundle (~/.prosa) to also re-import")
	cmd.Flags().BoolVar(&syncVerboseFlag, "verbose", false,
		"print one line per imported session, even on a TTY")
	cmd.Flags().BoolVar(&syncOverwriteFlag, "overwrite", false,
		"force re-import and re-push of every session, bypassing the dedup cache")
	return cmd
}

type syncJob struct {
	imp        importer.Importer
	path       string
	profile    string // profile the file was discovered under ("" → default)
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

	// Migrate any rows inserted under the seed `'local'` device id (v1 bundle
	// restore path) to the real fingerprint — those sessions came from this machine.
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

	if err := backfillProjectIdentity(ctx, s); err != nil {
		slog.Warn("project identity backfill failed", "err", err)
	}

	var (
		liveWork    []syncJob
		legacyWork  []syncJob
		legacyTotal int
		tmpDir      string
		bundle      *legacy.Bundle
	)
	profCfg, err := profiles.Load()
	if err != nil {
		slog.Warn("profiles config unreadable; scanning default locations only", "err", err)
		profCfg = profiles.Config{}
	}
	for _, imp := range registeredImporters() {
		for _, pr := range profCfg.Resolve(imp.Name(), imp) {
			for _, root := range pr.Roots {
				ps, err := imp.Walk(ctx, root)
				if err != nil {
					slog.Warn("walk failed", "agent", imp.Name(), "profile", pr.Name, "root", root, "err", err)
					continue
				}
				for _, p := range ps {
					liveWork = append(liveWork, syncJob{imp: imp, path: p, profile: pr.Name})
				}
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
		if g.JSON {
			emitSyncJSONSummary(os.Stdout, &syncCounts{})
			return nil
		}
		fmt.Fprintln(os.Stderr, "No sessions found.")
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
	interactive := !g.JSON && !syncVerboseFlag && IsInteractive()
	switch {
	case g.JSON:
		if err := runSyncJSON(ctx, os.Stdout, work, s, push, dev.ID, counts, opts); err != nil {
			return err
		}
	case interactive:
		if err := runSyncInteractive(ctx, work, s, push, dev.ID, counts, opts); err != nil {
			return err
		}
	default:
		if err := runSyncPlain(ctx, work, s, push, counts, opts); err != nil {
			return err
		}
		runSyncReconcile(ctx, push, dev.ID, counts, opts)
	}

	// Reconcile the edge-dependent orchestrator kind once the whole sweep
	// has landed every parent and child. Local-only: the server derives
	// its own orchestrator tags from the parent edges it receives.
	if err := s.RefreshOrchestratorKinds(ctx); err != nil {
		slog.Warn("orchestrator kind refresh failed", "err", err)
	}

	counts.denoiseCleaned = runDenoisePass(ctx, s)

	switch {
	case g.JSON:
		emitSyncJSONSummary(os.Stdout, counts)
	case interactive:
		counts.printSummaryTTY()
	default:
		counts.printSummary()
	}
	if counts.legacyErr > 0 {
		errWord := "errors"
		if counts.legacyErr == 1 {
			errWord = "error"
		}
		return fmt.Errorf("legacy bundle partially mirrored with %d %s", counts.legacyErr, errWord)
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

// backfillProjectIdentity fills project_remote / project_marker for rows
// that still have NULL identity columns. Each path is touched once.
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
