// Package browser opens URLs in the system default browser.
package browser

import (
	"context"
	"os/exec"
	"runtime"
)

// Open launches the platform default handler for url without waiting
// for the browser process to exit.
func Open(ctx context.Context, url string) error {
	name, args := commandForURL(runtime.GOOS, url)
	cmd := exec.CommandContext(ctx, name, args...)
	return cmd.Start()
}

func commandForURL(goos, url string) (string, []string) {
	switch goos {
	case "darwin":
		return "open", []string{url}
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", url}
	default:
		return "xdg-open", []string{url}
	}
}
