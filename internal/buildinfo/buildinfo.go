// Package buildinfo exposes version metadata injected by release builds.
package buildinfo

import "fmt"

var (
	// Version is the semantic version set by GoReleaser. Development builds
	// keep the default so local binaries are clearly identifiable.
	Version = "dev"
	// Commit is the git commit set by GoReleaser.
	Commit = "none"
	// BuildDate is the RFC3339 build timestamp set by GoReleaser.
	BuildDate = "unknown"
)

// String returns a compact version string suitable for CLI output.
func String() string {
	return fmt.Sprintf("%s (%s, %s)", Version, Commit, BuildDate)
}
