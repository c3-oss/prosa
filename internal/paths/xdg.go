// Package paths centralizes resolution of prosa's on-disk locations so the
// rest of the codebase never hard-codes ~/... or XDG layouts.
package paths

import (
	"fmt"
	"os"
	"path/filepath"
)

// UserHome returns the current user's home directory. Centralised so tests
// and future overrides have one hook point.
func UserHome() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home: %w", err)
	}
	return home, nil
}

// Home returns the prosa data root. Resolution order:
//  1. $PROSA_HOME if set (escape hatch for tests and exotic installs).
//  2. $XDG_DATA_HOME/prosa  (or $HOME/.local/share/prosa if XDG_DATA_HOME is unset).
//
// Cut 1 does not deviate per-OS — XDG layout is used on macOS too, per
// INTENT.md §4.
func Home() (string, error) {
	if v := os.Getenv("PROSA_HOME"); v != "" {
		return v, nil
	}
	if v := os.Getenv("XDG_DATA_HOME"); v != "" {
		return filepath.Join(v, "prosa"), nil
	}
	home, err := UserHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "prosa"), nil
}

func StorePath() (string, error) {
	h, err := Home()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, "store.db"), nil
}

// RawRoot returns the raw preservation directory for the given agent
// (e.g. "claude-code" -> $PROSA_HOME/raw/claude-code).
func RawRoot(agent string) (string, error) {
	h, err := Home()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, "raw", agent), nil
}

// ConfigHome returns the user's prosa config directory:
//  1. $PROSA_CONFIG_HOME (escape hatch).
//  2. $XDG_CONFIG_HOME/prosa (or $HOME/.config/prosa if XDG is unset).
//
// This is intentionally separate from Home() (XDG data) so a tarballed
// config can travel between machines without dragging the SQLite store
// + raw tree along.
func ConfigHome() (string, error) {
	if v := os.Getenv("PROSA_CONFIG_HOME"); v != "" {
		return v, nil
	}
	if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
		return filepath.Join(v, "prosa"), nil
	}
	home, err := UserHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "prosa"), nil
}

// AuthPath is where `prosa login` writes the saved token + server URL.
func AuthPath() (string, error) {
	c, err := ConfigHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(c, "auth.json"), nil
}
