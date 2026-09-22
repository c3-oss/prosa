package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/cli/rpc"
	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/rawlock"
	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/session"
)

var (
	pruneOlderThanFlag string
	pruneDryRunFlag    bool
	pruneLimitFlag     int
)

const (
	// pruneDefaultAge is the default --older-than window.
	pruneDefaultAge = 30 * 24 * time.Hour
	// pruneAdvisoryPushGrace keeps freshly pushed sessions out of the sync
	// advisory so the hint only surfaces settled history.
	pruneAdvisoryPushGrace = 7 * 24 * time.Hour
)

func newPruneCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "prune",
		Short: "Delete local raw copies of old sessions already stored on the server",
		Long: "prune deletes the local raw files of sessions the server confirmed\n" +
			"holding, once they have been inactive for the --older-than window.\n" +
			"Sessions stay listed, searchable, and viewable from the local store;\n" +
			"`prosa show --raw` streams a pruned raw from the server.",
		RunE: runPrune,
	}
	cmd.Flags().StringVar(&pruneOlderThanFlag, "older-than", "30d",
		"prune sessions whose last activity is older than this window (e.g. 30d, 12h)")
	cmd.Flags().BoolVar(&pruneDryRunFlag, "dry-run", false,
		"list what would be pruned without deleting anything")
	cmd.Flags().IntVar(&pruneLimitFlag, "limit", 0,
		"cap the number of sessions pruned (0 = no limit)")
	return cmd
}

// pruneJSONRecord is one NDJSON line emitted per candidate by
// `prosa prune --json`.
type pruneJSONRecord struct {
	Type           string `json:"type"` // always "session"
	SessionID      string `json:"session_id"`
	Agent          string `json:"agent"`
	Status         string `json:"status"` // pruned | would_prune | skipped | error
	ReclaimedBytes int64  `json:"reclaimed_bytes,omitempty"`
	Err            string `json:"err,omitempty"`
}

// pruneJSONSummary is the final NDJSON record with the run tally.
type pruneJSONSummary struct {
	Type           string `json:"type"` // always "summary"
	Pruned         int    `json:"pruned"`
	Skipped        int    `json:"skipped"`
	Errors         int    `json:"errors"`
	ReclaimedBytes int64  `json:"reclaimed_bytes"`
	DryRun         bool   `json:"dry_run"`
	Unconfirmed    int    `json:"unconfirmed,omitempty"`
}

func runPrune(cmd *cobra.Command, _ []string) error {
	ctx := rpc.ContextOrBackground(cmd.Context())

	olderThan, err := ParseLast(pruneOlderThanFlag)
	if err != nil {
		return fmt.Errorf("--older-than: %w", err)
	}

	a, err := rpc.LoadAuth()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("prune needs the server that holds the raws — run `prosa login --server <URL>` first")
		}
		return err
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

	dev, err := bindLocalDevice(ctx, s)
	if err != nil {
		return err
	}

	before := time.Now().UTC().Add(-olderThan)
	// Limit is applied after the server confirms a row. A SQL limit would
	// let unconfirmed old sessions consume the whole cap.
	candidates, err := s.ListPruneCandidates(ctx, dev.ID, before, 0)
	if err != nil {
		return fmt.Errorf("list prune candidates: %w", err)
	}

	enc := json.NewEncoder(os.Stdout)
	if len(candidates) == 0 {
		unconfirmed, err := s.CountOldUnconfirmed(ctx, dev.ID, before)
		if err != nil {
			return err
		}
		if g.JSON {
			return enc.Encode(pruneJSONSummary{
				Type: "summary", DryRun: pruneDryRunFlag, Unconfirmed: unconfirmed,
			})
		}
		if unconfirmed > 0 {
			fmt.Fprintf(os.Stderr, "Nothing to prune. Unconfirmed sessions older than the window: %d; run `prosa sync` first.\n", unconfirmed)
			return nil
		}
		fmt.Fprintln(os.Stderr, "Nothing to prune.")
		return nil
	}

	// Dry-run uses the same confirmation as a real run. Listing local
	// candidates alone reports sessions this command would skip.
	server := rpc.NormalizeServerURL(a.Server)
	serverHas, err := loadPruneManifest(ctx, server, a.Token)
	if err != nil {
		if isRemoteUnavailable(err) {
			return fmt.Errorf("server unavailable at %s; nothing was pruned", server)
		}
		return fmt.Errorf("confirm sessions with the server: %s", rpc.ConnectError(err))
	}

	var pruned, skipped, errCount int
	var reclaimed int64
	agents := map[string]struct{}{}
	var would []store.PruneCandidate
	kept := 0
	for _, c := range candidates {
		if err := ctx.Err(); err != nil {
			return err
		}
		if pruneLimitFlag > 0 && kept >= pruneLimitFlag {
			break
		}
		var status string
		var perr error
		if pruneDryRunFlag {
			status, perr = classifyPruneCandidate(serverHas, c)
		} else {
			status, perr = pruneOne(ctx, s, serverHas, c)
		}
		switch status {
		case "pruned", "would_prune":
			kept++
			pruned++
			reclaimed += c.RawSize
			if status == "pruned" {
				agents[c.Agent] = struct{}{}
			} else {
				would = append(would, c)
			}
		case "skipped":
			skipped++
		case "error":
			errCount++
		}
		if g.JSON {
			rec := pruneJSONRecord{Type: "session", SessionID: c.ID, Agent: c.Agent, Status: status}
			if status == "pruned" || status == "would_prune" {
				rec.ReclaimedBytes = c.RawSize
			}
			if perr != nil {
				rec.Err = perr.Error()
			}
			_ = enc.Encode(rec)
		} else if perr != nil {
			fmt.Fprintf(os.Stderr, "prune %s: %v\n", c.ID, perr)
		}
	}

	if !pruneDryRunFlag {
		removeEmptyRawDirs(agents)
	}

	if g.JSON {
		if err := enc.Encode(pruneJSONSummary{
			Type: "summary", Pruned: pruned, Skipped: skipped,
			Errors: errCount, ReclaimedBytes: reclaimed, DryRun: pruneDryRunFlag,
		}); err != nil {
			return err
		}
		return pruneFinished(errCount)
	}
	if pruneDryRunFlag {
		return finishPruneDryRun(would, pruned, skipped, reclaimed, errCount)
	}
	fmt.Fprintf(os.Stderr, "pruned %d sessions · reclaimed %s · skipped %d · errors %d\n",
		pruned, humanBytes(reclaimed), skipped, errCount)
	return pruneFinished(errCount)
}

// loadPruneManifest confirms candidates against the server. Tests replace it.
var loadPruneManifest = func(ctx context.Context, server, token string) (map[string]serverManifestRow, error) {
	push := &pusher{client: rpc.Sessions(server, token), server: server}
	return fetchServerManifest(ctx, push)
}

func pruneFinished(errCount int) error {
	if errCount > 0 {
		return fmt.Errorf("prune finished with %d errors", errCount)
	}
	return nil
}

// errRawChanged means the on-disk bytes are no longer the hash the server
// confirmed. The file must stay; a newer import may already own it.
var errRawChanged = errors.New("local raw changed since the server confirmed it; skipping")

func pruneServerReject(serverHas map[string]serverManifestRow, c store.PruneCandidate) error {
	remote, ok := serverHas[c.ID]
	if !ok || remote.RawHash != c.RawHash {
		return fmt.Errorf("not confirmed on server (hash mismatch or missing); skipping")
	}
	if remote.ProjectionVersion < session.ProjectionVersion {
		return fmt.Errorf("server projection is stale; sync first, then prune")
	}
	return nil
}

// confirmRawBytes checks the file still hashes to the confirmed raw.
// A missing file is fine: there is nothing newer to protect.
func confirmRawBytes(c store.PruneCandidate) error {
	hash, _, err := importerutil.HashAndSize(c.RawPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	if hash != c.RawHash {
		return errRawChanged
	}
	return nil
}

func classifyPruneCandidate(serverHas map[string]serverManifestRow, c store.PruneCandidate) (string, error) {
	if err := pruneServerReject(serverHas, c); err != nil {
		return "skipped", err
	}
	if err := confirmRawBytes(c); err != nil {
		if errors.Is(err, errRawChanged) {
			return "skipped", err
		}
		return "error", err
	}
	return "would_prune", nil
}

// pruneOne verifies one candidate against the server manifest, re-checks the
// local bytes under the raw lock, flips the row, and deletes the file.
// DB first: the dangerous inconsistency is a deleted file the store still
// believes in, not the reverse.
func pruneOne(ctx context.Context, s *store.Store, serverHas map[string]serverManifestRow, c store.PruneCandidate) (string, error) {
	if err := pruneServerReject(serverHas, c); err != nil {
		return "skipped", err
	}
	release, err := rawlock.Hold(c.ID)
	if err != nil {
		return "error", err
	}
	defer release()

	sess, err := s.GetSession(ctx, c.ID)
	if err != nil {
		return "error", err
	}
	// The importer commits the new hash before it drops the lock. A mismatch
	// here means those bytes are not the ones the server confirmed.
	if sess.PrunedAt != nil || sess.RawHash != c.RawHash || sess.RawPath != c.RawPath {
		return "skipped", nil
	}
	if err := confirmRawBytes(c); err != nil {
		if errors.Is(err, errRawChanged) {
			return "skipped", err
		}
		return "error", err
	}
	ok, err := s.MarkPruned(ctx, c.ID, c.RawHash)
	if err != nil {
		return "error", err
	}
	if !ok {
		return "skipped", nil
	}
	if err := os.Remove(c.RawPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		if cerr := s.ClearPruned(ctx, c.ID); cerr != nil {
			return "error", fmt.Errorf("delete raw: %w (and revert failed: %v)", err, cerr)
		}
		return "error", fmt.Errorf("delete raw: %w", err)
	}
	return "pruned", nil
}

func finishPruneDryRun(would []store.PruneCandidate, pruned, skipped int, reclaimed int64, errCount int) error {
	if len(would) == 0 {
		fmt.Fprintf(os.Stderr, "Nothing to prune. skipped %d\n", skipped)
		return pruneFinished(errCount)
	}
	cols := []render.TableColumn{
		{Header: "SESSION"},
		{Header: "AGENT"},
		{Header: "LAST ACTIVITY"},
		{Header: "SIZE", Right: true},
	}
	rows := make([][]render.TableCell, 0, len(would))
	for _, c := range would {
		rows = append(rows, []render.TableCell{
			render.Cell(c.ID),
			render.Cell(c.Agent),
			{Text: c.LastActivityAt.Local().Format("2006-01-02 15:04"), Style: render.StyleMuted},
			{Text: humanBytes(c.RawSize), Style: render.StyleAccent},
		})
	}
	if err := render.Table(os.Stdout, cols, rows, IsInteractive()); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "would prune %d sessions · reclaim %s · skipped %d\n",
		pruned, humanBytes(reclaimed), skipped)
	return pruneFinished(errCount)
}

// removeEmptyRawDirs clears out now-empty YYYY/MM shard directories under
// each touched agent's raw root. Best effort: os.Remove refuses non-empty
// directories, which is exactly the guard we want.
func removeEmptyRawDirs(agents map[string]struct{}) {
	for agent := range agents {
		root, err := paths.RawRoot(agent)
		if err != nil {
			continue
		}
		var dirs []string
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err == nil && d.IsDir() && path != root {
				dirs = append(dirs, path)
			}
			return nil
		})
		// Deepest first so an emptied MM dir lets its YYYY parent go too.
		sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) > len(dirs[j]) })
		for _, d := range dirs {
			_ = os.Remove(d)
		}
	}
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
