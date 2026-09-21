// Package rawlock serializes rewriting a session's raw file with deleting it.
//
// An importer publishes new bytes with a rename, then commits the new hash.
// Prune unlinks only after the server confirmed a hash. Those two steps have
// to be one critical section: a prune that unlinks between the rename and the
// commit deletes bytes the server never confirmed, and the following commit
// records a hash whose file is already gone.
package rawlock

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"github.com/c3-oss/prosa/internal/paths"
	"github.com/c3-oss/prosa/pkg/session"
)

// Hold takes the exclusive per-session lock. The returned function releases
// it. The lock file lives under the prosa data dir so every process on this
// machine shares it.
func Hold(sessionID string) (func(), error) {
	if err := session.ValidateID(sessionID); err != nil {
		return nil, fmt.Errorf("raw lock: %w", err)
	}
	home, err := paths.Home()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(home, "locks")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("raw lock dir: %w", err)
	}
	f, err := os.OpenFile(filepath.Join(dir, sessionID+".lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("raw lock %s: %w", sessionID, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("raw lock %s: %w", sessionID, err)
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

// With holds the session lock for the duration of fn.
func With(sessionID string, fn func() error) error {
	release, err := Hold(sessionID)
	if err != nil {
		return err
	}
	defer release()
	return fn()
}
