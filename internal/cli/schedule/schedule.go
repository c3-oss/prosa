// Package schedule installs and removes the prosa-sync background job
// using the OS-native scheduler: launchd on macOS, systemd user timers
// on Linux. The package surface is intentionally small — Install,
// Uninstall, Status — so callers (prosa setup, prosa schedule install)
// stay agnostic to which OS they target.
package schedule

import (
	"context"
	"fmt"
	"runtime"
	"time"
)

// Status describes the current state of the prosa-sync scheduled job.
type Status struct {
	Installed bool
	Interval  time.Duration
	UnitPath  string // plist path on macOS; .timer path on Linux
}

// Scheduler installs/removes the prosa-sync job. Implementations are
// non-portable. Other platforms get ErrUnsupported from New().
type Scheduler interface {
	Install(ctx context.Context, binaryPath string, interval time.Duration) error
	Uninstall(ctx context.Context) error
	Status(ctx context.Context) (Status, error)
}

// ErrUnsupported is returned by New() on platforms we don't support.
var ErrUnsupported = fmt.Errorf("scheduler not supported on this platform")

// New returns the right Scheduler for the given GOOS. Pass
// runtime.GOOS in production; tests can pass "linux" or "darwin"
// directly to exercise the corresponding implementation.
func New(goos string) (Scheduler, error) {
	switch goos {
	case "darwin":
		return newMacOS()
	case "linux":
		return newLinux()
	default:
		return nil, fmt.Errorf("%w (%s)", ErrUnsupported, goos)
	}
}

// NewForCurrent is the convenience wrapper for callers that want
// runtime.GOOS without importing it themselves.
func NewForCurrent() (Scheduler, error) {
	return New(runtime.GOOS)
}
