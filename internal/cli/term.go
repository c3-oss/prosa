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

// TerminalWidth returns the current stdout width, falling back to the
// design baseline when stdout is not attached to a terminal.
func TerminalWidth() int {
	width, _, err := term.GetSize(int(os.Stdout.Fd()))
	if err != nil || width <= 0 {
		return 80
	}
	return width
}
