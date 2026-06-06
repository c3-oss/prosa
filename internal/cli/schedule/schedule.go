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

// State describes the current state of the prosa-sync scheduled job.
type State struct {
	Installed bool
	Interval  time.Duration
	UnitPath  string // plist path on macOS; .timer path on Linux
}

// ErrUnsupported is returned on platforms we don't support.
var ErrUnsupported = fmt.Errorf("scheduler not supported on this platform")

// Install installs or replaces the prosa-sync scheduled job for the
// current platform.
func Install(ctx context.Context, binaryPath string, interval time.Duration) error {
	return installForGOOS(ctx, runtime.GOOS, binaryPath, interval)
}

func installForGOOS(ctx context.Context, goos, binaryPath string, interval time.Duration) error {
	switch goos {
	case "darwin":
		return macSchedulerInstall(ctx, binaryPath, interval)
	case "linux":
		return linuxSchedulerInstall(ctx, binaryPath, interval)
	default:
		return fmt.Errorf("%w (%s)", ErrUnsupported, goos)
	}
}

// Uninstall removes the prosa-sync scheduled job for the current
// platform. Missing jobs are treated as success.
func Uninstall(ctx context.Context) error {
	return uninstallForGOOS(ctx, runtime.GOOS)
}

func uninstallForGOOS(ctx context.Context, goos string) error {
	switch goos {
	case "darwin":
		return macSchedulerUninstall(ctx)
	case "linux":
		return linuxSchedulerUninstall(ctx)
	default:
		return fmt.Errorf("%w (%s)", ErrUnsupported, goos)
	}
}

// Status reports the prosa-sync scheduled job state for the current
// platform.
func Status(ctx context.Context) (State, error) {
	return statusForGOOS(ctx, runtime.GOOS)
}

func statusForGOOS(ctx context.Context, goos string) (State, error) {
	switch goos {
	case "darwin":
		return macSchedulerStatus(ctx)
	case "linux":
		return linuxSchedulerStatus(ctx)
	default:
		return State{}, fmt.Errorf("%w (%s)", ErrUnsupported, goos)
	}
}
