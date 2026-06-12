// Package profiles loads and saves the local per-agent profile config
// (profiles.json). Only the profile name reaches the server; the path is local.
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

// Profile is one named location for an agent. Path is the agent's home dir
// (e.g. ~/.codex-work); the importer derives its scan roots from it.
type Profile struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// Config is the profiles.json document, keyed by agent name.
type Config struct {
	Version int                  `json:"version"`
	Agents  map[string][]Profile `json:"agents"`
}

// Load reads profiles.json; a missing file yields an empty config.
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

// Save atomically writes profiles.json with 0600 permissions.
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

// For returns an agent's configured profiles in name order.
func (c Config) For(agent string) []Profile {
	ps := append([]Profile(nil), c.Agents[agent]...)
	sort.Slice(ps, func(i, j int) bool { return ps[i].Name < ps[j].Name })
	return ps
}

func (c Config) Find(agent, name string) (Profile, bool) {
	for _, p := range c.Agents[agent] {
		if p.Name == name {
			return p, true
		}
	}
	return Profile{}, false
}

// Set inserts or replaces a profile; returns true when it replaced one.
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

// Remove deletes a named profile; returns false when nothing matched.
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

// Resolved is one effective profile: a name plus the roots to scan for it.
type Resolved struct {
	Name  string
	Path  string
	Roots []string
}

type rooter interface {
	DefaultRoots() []string
	RootsUnder(base string) []string
}

// Resolve returns an agent's effective profiles: a synthesized "default"
// (overridable via config) first, then the configured extras by name.
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
