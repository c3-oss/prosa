package cli

import (
	"os"

	"golang.org/x/term"
)

// IsInteractive reports whether both stdout and stderr are attached to a
// TTY. Bubble Tea and color rendering disable themselves when either is
// piped or redirected — common in cron/LaunchAgent invocations where
// otherwise we'd emit ANSI escape garbage into log files.
func IsInteractive() bool {
	return term.IsTerminal(int(os.Stdout.Fd())) && term.IsTerminal(int(os.Stderr.Fd()))
}
