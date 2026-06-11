// Package profiles loads and saves the local profile configuration: per-agent,
// named locations a device imports sessions from. A profile's Path is the
// agent's home directory (the CODEX_HOME-equivalent), which each importer
// resolves into scan roots. The mapping is purely local — only the profile
// name travels to the server on a session row.
package profiles

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/pkg/session"
)

// Version is the on-disk schema version of profiles.json.
const Version = 1

// Profile is one named location for an agent on this device. Path is the
// agent's base/home directory (e.g. ~/.codex-work); the importer derives the
// directories it actually scans from it.
type Profile struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// Config is the whole profiles.json document. Agents maps an agent name to its
// configured profiles. The synthesized "default" profile is never stored here
// unless the user explicitly overrides its path.
type Config struct {
	Version int                  `json:"version"`
	Agents  map[string][]Profile `json:"agents"`
}

// Load reads profiles.json. A missing file is not an error: it returns an
// empty config, which resolves to just the default profile per agent.
func Load() (Config, error) {
	path, err := paths.ProfilesPath()
	if err != nil {
		return Config{}, err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Config{Version: Version, Agents: map[string][]Profile{}}, nil
		}
		return Config{}, err
	}
	var c Config
	if err := json.Unmarshal(body, &c); err != nil {
		return Config{}, fmt.Errorf("parse %s: %w", path, err)
	}
	if c.Agents == nil {
		c.Agents = map[string][]Profile{}
	}
	return c, nil
}

// Save atomically writes profiles.json with 0600 permissions, mirroring how
// auth.json is persisted.
func Save(c Config) error {
	if c.Version == 0 {
		c.Version = Version
	}
	final, err := paths.ProfilesPath()
	if err != nil {
		return err
	}
	dir := filepath.Dir(final)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, final)
}

// For returns the configured profiles for an agent in stable name order.
// Never includes the synthesized default unless the user stored an override.
func (c Config) For(agent string) []Profile {
	ps := append([]Profile(nil), c.Agents[agent]...)
	sort.Slice(ps, func(i, j int) bool { return ps[i].Name < ps[j].Name })
	return ps
}

// Find returns the named profile for an agent and whether it exists.
func (c Config) Find(agent, name string) (Profile, bool) {
	for _, p := range c.Agents[agent] {
		if p.Name == name {
			return p, true
		}
	}
	return Profile{}, false
}

// Set inserts or updates a profile for an agent, replacing any existing entry
// with the same name. Returns true when an existing profile was replaced.
func (c *Config) Set(agent string, p Profile) bool {
	if c.Agents == nil {
		c.Agents = map[string][]Profile{}
	}
	list := c.Agents[agent]
	for i := range list {
		if list[i].Name == p.Name {
			list[i] = p
			c.Agents[agent] = list
			return true
		}
	}
	c.Agents[agent] = append(list, p)
	return false
}

// Remove deletes a named profile for an agent. Returns false when nothing
// matched. Prunes the agent key when its last profile is removed.
func (c *Config) Remove(agent, name string) bool {
	list := c.Agents[agent]
	for i := range list {
		if list[i].Name == name {
			c.Agents[agent] = append(list[:i], list[i+1:]...)
			if len(c.Agents[agent]) == 0 {
				delete(c.Agents, agent)
			}
			return true
		}
	}
	return false
}

// Resolved is one effective profile after merging configured entries with the
// synthesized default: a name plus the filesystem roots to scan for it.
type Resolved struct {
	Name  string
	Path  string // base path; empty for the synthesized default
	Roots []string
}

// rooter is the slice of the importer contract profile resolution needs: the
// default roots and how to expand a base path into scan roots.
type rooter interface {
	DefaultRoots() []string
	RootsUnder(base string) []string
}

// Resolve computes the effective profiles for an agent: always a "default"
// (the importer's DefaultRoots, unless the config overrides its path) plus
// every other configured profile expanded through RootsUnder. The result is
// ordered default-first, then the rest by name.
func (c Config) Resolve(agent string, imp rooter) []Resolved {
	var out []Resolved
	def := Resolved{Name: session.DefaultProfile, Roots: imp.DefaultRoots()}
	var extras []Resolved
	for _, p := range c.For(agent) {
		if p.Name == session.DefaultProfile {
			def = Resolved{Name: session.DefaultProfile, Path: p.Path, Roots: imp.RootsUnder(p.Path)}
			continue
		}
		extras = append(extras, Resolved{Name: p.Name, Path: p.Path, Roots: imp.RootsUnder(p.Path)})
	}
	out = append(out, def)
	out = append(out, extras...)
	return out
}
