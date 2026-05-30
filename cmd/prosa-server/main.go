// prosa-server is the cross-device backend: receives push uploads,
// hosts FTS reads, and brokers device-code auth. The configuration is
// read from env vars (see internal/server.Config). docs/server.md walks
// through the docker-compose dev stack.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/c3-oss/prosa/internal/buildinfo"
	"github.com/c3-oss/prosa/internal/server"
)

func main() {
	approveCode := flag.String("approve", "",
		"approve a PENDING device-code user_code (admin flow; requires PROSA_ADMIN_TOKEN)")
	flag.Parse()

	if *approveCode != "" {
		if err := runApprove(*approveCode); err != nil {
			fmt.Fprintln(os.Stderr, "approve:", err)
			os.Exit(1)
		}
		return
	}

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

// runApprove is the admin bridge until the painel ships. It hits the
// running prosa-server's AuthService.ApproveLogin over Connect, using
// PROSA_ADMIN_TOKEN as the proof. Implemented in admin.go.
func runApprove(userCode string) error {
	cfg, err := server.LoadForApprove()
	if err != nil {
		return err
	}
	return adminApprove(context.Background(), cfg, userCode)
}
