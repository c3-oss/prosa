// prosa-server is the cross-device backend: receives push uploads,
// hosts FTS reads, and brokers CLI PKCE login. Configuration is read
// from env vars (see internal/server.Config). docs/server.md walks
// through the docker-compose dev stack.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/c3-oss/prosa/internal/buildinfo"
	"github.com/c3-oss/prosa/internal/server"
)

func main() {
	if err := runServer(); err != nil {
		fmt.Fprintln(os.Stderr, "server:", err)
		os.Exit(1)
	}
}

func runServer() error {
	slog.Info("prosa-server starting", "version", buildinfo.String())
	cfg, err := server.Load()
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	s, err := server.New(ctx, cfg)
	if err != nil {
		return err
	}
	defer s.Close()
	return s.Serve(ctx)
}
