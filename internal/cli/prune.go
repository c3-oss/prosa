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
	"github.com/c3-oss/prosa/internal/device"
	"github.com/c3-oss/prosa/internal/paths"
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
	Status         string `json:"status"` // pruned | skipped | error
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

	before := time.Now().UTC().Add(-olderThan)
	candidates, err := s.ListPruneCandidates(ctx, device.IDOnce(), before, pruneLimitFlag)
	if err != nil {
		return fmt.Errorf("list prune candidates: %w", err)
	}

	enc := json.NewEncoder(os.Stdout)
	if len(candidates) == 0 {
		if g.JSON {
			return enc.Encode(pruneJSONSummary{Type: "summary", DryRun: pruneDryRunFlag})
		}
		fmt.Fprintln(os.Stderr, "Nothing to prune.")
		return nil
	}

	if pruneDryRunFlag {
		return emitPruneDryRun(enc, candidates)
	}

	// The candidate filter already requires a locally recorded push, but
	// deletion is destructive: re-confirm every id against the server
	// manifest before touching the filesystem.
	server := rpc.NormalizeServerURL(a.Server)
	push := &pusher{client: rpc.Sessions(server, a.Token), store: s, server: server}
	serverHas, err := fetchServerManifest(ctx, push)
	if err != nil {
		if isRemoteUnavailable(err) {
			return fmt.Errorf("server unavailable at %s; nothing was pruned", server)
		}
		return fmt.Errorf("confirm sessions with the server: %s", rpc.ConnectError(err))
	}

	var pruned, skipped, errCount int
	var reclaimed int64
	agents := map[string]struct{}{}
	for _, c := range candidates {
		if err := ctx.Err(); err != nil {
			return err
		}
		status, perr := pruneOne(ctx, s, serverHas, c)
		switch status {
		case "pruned":
			pruned++
			reclaimed += c.RawSize
			agents[c.Agent] = struct{}{}
		case "skipped":
			skipped++
		case "error":
			errCount++
		}
		if g.JSON {
			rec := pruneJSONRecord{Type: "session", SessionID: c.ID, Agent: c.Agent, Status: status}
			if status == "pruned" {
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

	removeEmptyRawDirs(agents)

	if g.JSON {
		return enc.Encode(pruneJSONSummary{
			Type: "summary", Pruned: pruned, Skipped: skipped,
			Errors: errCount, ReclaimedBytes: reclaimed,
		})
	}
	fmt.Fprintf(os.Stderr, "pruned %d sessions · reclaimed %s · skipped %d · errors %d\n",
		pruned, humanBytes(reclaimed), skipped, errCount)
	if errCount > 0 {
		return fmt.Errorf("prune finished with %d errors", errCount)
	}
	return nil
}

// pruneOne verifies one candidate against the server manifest, flips the
// row, and deletes the raw file. DB first: the dangerous inconsistency is a
// deleted file the store still believes in, not the reverse.
func pruneOne(ctx context.Context, s *store.Store, serverHas map[string]serverManifestRow, c store.PruneCandidate) (string, error) {
	remote, ok := serverHas[c.ID]
	if !ok || remote.RawHash != c.RawHash {
		return "skipped", fmt.Errorf("not confirmed on server (hash mismatch or missing); skipping")
	}
	if remote.ProjectionVersion < session.ProjectionVersion {
		return "skipped", fmt.Errorf("server projection is stale; sync first, then prune")
	}
	ok, err := s.MarkPruned(ctx, c.ID, c.RawHash)
	if err != nil {
		return "error", err
	}
	if !ok {
		// Raw changed or a concurrent prune won since candidate listing.
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

func emitPruneDryRun(enc *json.Encoder, candidates []store.PruneCandidate) error {
	var total int64
	if g.JSON {
		for _, c := range candidates {
			_ = enc.Encode(pruneJSONRecord{
				Type: "session", SessionID: c.ID, Agent: c.Agent,
				Status: "pruned", ReclaimedBytes: c.RawSize,
			})
			total += c.RawSize
		}
		return enc.Encode(pruneJSONSummary{
			Type: "summary", Pruned: len(candidates),
			ReclaimedBytes: total, DryRun: true,
		})
	}

	cols := []render.TableColumn{
		{Header: "SESSION"},
		{Header: "AGENT"},
		{Header: "LAST ACTIVITY"},
		{Header: "SIZE", Right: true},
	}
	rows := make([][]render.TableCell, 0, len(candidates))
	for _, c := range candidates {
		rows = append(rows, []render.TableCell{
			render.Cell(c.ID),
			render.Cell(c.Agent),
			{Text: c.LastActivityAt.Local().Format("2006-01-02 15:04"), Style: render.StyleMuted},
			{Text: humanBytes(c.RawSize), Style: render.StyleAccent},
		})
		total += c.RawSize
	}
	if err := render.Table(os.Stdout, cols, rows, IsInteractive()); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "would prune %d sessions · reclaim %s\n",
		len(candidates), humanBytes(total))
	return nil
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
