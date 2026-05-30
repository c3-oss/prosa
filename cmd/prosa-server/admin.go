package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"connectrpc.com/connect"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server"
)

// adminApprove is implemented out-of-process: it calls the running
// prosa-server's ApproveLogin RPC over h2c. We do NOT call the handler
// in-process because the server we want to talk to is usually a
// separate `prosa-server` instance.
func adminApprove(ctx context.Context, cfg server.Config, userCode string) error {
	addr := cfg.ListenAddr
	if !strings.HasPrefix(addr, "http://") && !strings.HasPrefix(addr, "https://") {
		// Convert ":7070" to "http://localhost:7070".
		host := strings.TrimPrefix(addr, ":")
		addr = "http://localhost:" + host
	}
	client := prosav1connect.NewAuthServiceClient(http.DefaultClient, addr)
	resp, err := client.ApproveLogin(ctx, connect.NewRequest(&prosav1.ApproveLoginRequest{
		UserCode:   userCode,
		AdminToken: cfg.AdminToken,
	}))
	if err != nil {
		return err
	}
	fmt.Printf("approved device %s\n", resp.Msg.DeviceId)
	return nil
}
