// prosa-panel is the web UI for prosa. It talks to prosa-server via
// the Connect API, owns OAuth and cookies, and renders templ/HTML
// views with HTMX-driven swap-on-click navigation. See docs/panel.md.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/c3-oss/prosa/internal/buildinfo"
	"github.com/c3-oss/prosa/internal/panel"
)

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Fprintf(os.Stdout, "prosa-panel version %s\n", buildinfo.String())
		return
	}
	slog.Info("prosa-panel starting", "version", buildinfo.String())
	cfg, err := panel.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "panel config:", err)
		os.Exit(2)
	}
	p, err := panel.New(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "panel build:", err)
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := p.Serve(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "panel serve:", err)
		os.Exit(1)
	}
}
