package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/internal/profiles"
	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/session"
)

func newProfilesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "profiles",
		Short: "Manage per-agent import locations (profiles) on this device",
		Long: "A profile is a named location for an agent, e.g. an alternate " +
			"CODEX_HOME holding a second authenticated account. Every agent has a " +
			"`default` profile pointing at its standard location; add more to import " +
			"sessions from extra directories.",
	}
	cmd.AddCommand(newProfilesListCmd())
	cmd.AddCommand(newProfilesAddCmd())
	cmd.AddCommand(newProfilesRemoveCmd())
	cmd.AddCommand(newProfilesSetPathCmd())
	return cmd
}

func newProfilesListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List configured profiles and how many sessions each holds",
		Args:  cobra.NoArgs,
		RunE:  runProfilesList,
	}
}

func newProfilesAddCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "add <agent> <name> <path>",
		Short: "Add a profile for an agent, pointing at a base directory",
		Args:  cobra.ExactArgs(3),
		RunE:  runProfilesAdd,
	}
}

func newProfilesRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "remove <agent> <name>",
		Short: "Remove a configured profile (does not delete imported sessions)",
		Args:  cobra.ExactArgs(2),
		RunE:  runProfilesRemove,
	}
}

func newProfilesSetPathCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set-path <agent> <name> <path>",
		Short: "Update the base directory a profile points at",
		Args:  cobra.ExactArgs(3),
		RunE:  runProfilesSetPath,
	}
}

// profileRow is one displayed profile with its session count.
type profileRow struct {
	Agent    string   `json:"agent"`
	Name     string   `json:"profile"`
	Base     string   `json:"base,omitempty"` // empty for the synthesized default
	Roots    []string `json:"roots"`
	Sessions int      `json:"sessions"`
}

type profileMutationJSON struct {
	Action   string `json:"action"`
	Agent    string `json:"agent"`
	Profile  string `json:"profile"`
	Path     string `json:"path,omitempty"`
	Replaced bool   `json:"replaced,omitempty"`
}

func runProfilesList(cmd *cobra.Command, _ []string) error {
	if err := rejectProfilesSessionGlobals(cmd); err != nil {
		return err
	}
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	cfg, err := profiles.Load()
	if err != nil {
		return fmt.Errorf("load profiles: %w", err)
	}

	counts, err := profileSessionCounts(ctx)
	if err != nil {
		return err
	}

	var rows []profileRow
	for _, imp := range registeredImporters() {
		agent := imp.Name()
		seen := map[string]bool{}
		for _, r := range cfg.Resolve(agent, imp) {
			seen[r.Name] = true
			rows = append(rows, profileRow{
				Agent:    agent,
				Name:     r.Name,
				Base:     r.Path,
				Roots:    r.Roots,
				Sessions: counts[agent][r.Name],
			})
		}
		// Surface profiles that still hold sessions but are no longer configured.
		var orphans []string
		for name := range counts[agent] {
			if !seen[name] {
				orphans = append(orphans, name)
			}
		}
		sort.Strings(orphans)
		for _, name := range orphans {
			rows = append(rows, profileRow{
				Agent:    agent,
				Name:     name,
				Sessions: counts[agent][name],
			})
		}
	}

	if g.JSON {
		enc := json.NewEncoder(os.Stdout)
		for _, r := range rows {
			if err := enc.Encode(r); err != nil {
				return err
			}
		}
		return nil
	}
	return renderProfileTable(os.Stdout, rows, IsInteractive())
}

// profileSessionCounts returns counts[agent][profile]. Counts are
// supplementary, so a missing or unreadable store yields empty counts.
func profileSessionCounts(ctx context.Context) (map[string]map[string]int, error) {
	out := map[string]map[string]int{}
	storePath, err := paths.StorePath()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(storePath); os.IsNotExist(err) {
		return out, nil
	}
	s, err := store.OpenReadOnly(ctx, storePath)
	if err != nil {
		return out, nil
	}
	defer func() { _ = s.Close() }()
	pcs, err := s.ProfileCounts(ctx)
	if err != nil {
		return out, nil
	}
	for _, pc := range pcs {
		if out[pc.Agent] == nil {
			out[pc.Agent] = map[string]int{}
		}
		out[pc.Agent][pc.Profile] = pc.Count
	}
	return out, nil
}

func renderProfileTable(w *os.File, rows []profileRow, interactive bool) error {
	cols := []render.TableColumn{
		{Header: "AGENT"},
		{Header: "PROFILE"},
		{Header: "LOCATION"},
		{Header: "SESSIONS", Right: true},
	}
	cells := make([][]render.TableCell, 0, len(rows))
	for _, r := range rows {
		location := render.Cell(strings.Join(r.Roots, ", "))
		if location.Text == "" {
			location = render.TableCell{Text: "(not configured)", Style: render.StyleMuted}
		}
		cells = append(cells, []render.TableCell{
			render.Cell(r.Agent),
			render.Cell(r.Name),
			location,
			{Text: fmt.Sprintf("%d", r.Sessions), Style: render.StyleAccent},
		})
	}
	return render.Table(w, cols, cells, interactive)
}

func runProfilesAdd(cmd *cobra.Command, args []string) error {
	if err := rejectProfilesSessionGlobals(cmd); err != nil {
		return err
	}
	agent, name, path := args[0], args[1], args[2]
	if err := validateProfileArgs(agent, name); err != nil {
		return err
	}
	path, err := normalizeProfilePath(path)
	if err != nil {
		return err
	}
	cfg, err := profiles.Load()
	if err != nil {
		return fmt.Errorf("load profiles: %w", err)
	}
	replaced := cfg.Set(agent, profiles.Profile{Name: name, Path: path})
	if err := profiles.Save(cfg); err != nil {
		return fmt.Errorf("save profiles: %w", err)
	}
	warnIfMissing(path)
	verb := "added"
	if replaced {
		verb = "updated"
	}
	if g.JSON {
		return emitProfileMutationJSON(os.Stdout, profileMutationJSON{
			Action:   "add",
			Agent:    agent,
			Profile:  name,
			Path:     path,
			Replaced: replaced,
		})
	}
	fmt.Fprintf(os.Stdout, "%s profile %s/%s → %s\n", verb, agent, name, path)
	return nil
}

func runProfilesSetPath(cmd *cobra.Command, args []string) error {
	if err := rejectProfilesSessionGlobals(cmd); err != nil {
		return err
	}
	agent, name, path := args[0], args[1], args[2]
	if err := validateProfileArgs(agent, name); err != nil {
		return err
	}
	path, err := normalizeProfilePath(path)
	if err != nil {
		return err
	}
	cfg, err := profiles.Load()
	if err != nil {
		return fmt.Errorf("load profiles: %w", err)
	}
	if _, ok := cfg.Find(agent, name); !ok && name != session.DefaultProfile {
		return fmt.Errorf("no profile %s/%s; use `prosa profiles add` to create it", agent, name)
	}
	cfg.Set(agent, profiles.Profile{Name: name, Path: path})
	if err := profiles.Save(cfg); err != nil {
		return fmt.Errorf("save profiles: %w", err)
	}
	warnIfMissing(path)
	if g.JSON {
		return emitProfileMutationJSON(os.Stdout, profileMutationJSON{
			Action:  "set_path",
			Agent:   agent,
			Profile: name,
			Path:    path,
		})
	}
	fmt.Fprintf(os.Stdout, "set profile %s/%s → %s\n", agent, name, path)
	return nil
}

func runProfilesRemove(cmd *cobra.Command, args []string) error {
	if err := rejectProfilesSessionGlobals(cmd); err != nil {
		return err
	}
	agent, name := args[0], args[1]
	if err := validateAgentName(agent); err != nil {
		return err
	}
	if name == session.DefaultProfile {
		return fmt.Errorf("cannot remove the built-in %q profile", session.DefaultProfile)
	}
	cfg, err := profiles.Load()
	if err != nil {
		return fmt.Errorf("load profiles: %w", err)
	}
	if !cfg.Remove(agent, name) {
		return fmt.Errorf("no profile %s/%s", agent, name)
	}
	if err := profiles.Save(cfg); err != nil {
		return fmt.Errorf("save profiles: %w", err)
	}
	if g.JSON {
		return emitProfileMutationJSON(os.Stdout, profileMutationJSON{
			Action:  "remove",
			Agent:   agent,
			Profile: name,
		})
	}
	fmt.Fprintf(os.Stdout, "removed profile %s/%s (imported sessions are kept)\n", agent, name)
	return nil
}

func emitProfileMutationJSON(w io.Writer, payload profileMutationJSON) error {
	return json.NewEncoder(w).Encode(payload)
}

func rejectProfilesSessionGlobals(cmd *cobra.Command) error {
	for _, name := range []string{"last", "since", "between", "project", "device", "agent", "profile", "all", "remote"} {
		if cmd.Flags().Changed(name) {
			return fmt.Errorf("profiles does not accept --%s", name)
		}
	}
	return nil
}

func validateProfileArgs(agent, name string) error {
	if err := validateAgentName(agent); err != nil {
		return err
	}
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("profile name must not be empty")
	}
	return nil
}

// normalizeProfilePath expands a leading ~ and makes the path absolute.
func normalizeProfilePath(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", fmt.Errorf("path must not be empty")
	}
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := paths.UserHome()
		if err != nil {
			return "", err
		}
		p = filepath.Join(home, strings.TrimPrefix(p, "~"))
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	return abs, nil
}

func warnIfMissing(path string) {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "warning: %s does not exist yet\n", path)
	}
}
