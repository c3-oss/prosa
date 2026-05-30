package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"connectrpc.com/connect"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/cli/rpc"
	"github.com/c3-oss/prosa/internal/device"
)

var loginServerFlag string

func newLoginCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "login",
		Short: "Authenticate this device against a prosa-server",
		Long: "Starts the device-code flow: prints a user_code + URL, then polls\n" +
			"until the code is approved (admin/painel). On success the bearer is\n" +
			"saved to ~/.config/prosa/auth.json and every subsequent prosa\n" +
			"command (sync, search --remote, devices) attaches it.",
		RunE: runLogin,
	}
	cmd.Flags().StringVar(&loginServerFlag, "server", "", "prosa-server URL (e.g. http://localhost:7070)")
	return cmd
}

func newLogoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Forget the saved server token",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := rpc.DeleteAuth(); err != nil {
				return err
			}
			fmt.Fprintln(os.Stdout, "logged out")
			return nil
		},
	}
}

var (
	styleUserCode = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("220"))
	styleURL      = lipgloss.NewStyle().Foreground(lipgloss.Color("51"))
	styleSubtle   = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
)

func runLogin(cmd *cobra.Command, _ []string) error {
	ctx := rpc.ContextOrBackground(cmd.Context())
	server := loginServerFlag
	if server == "" {
		return errors.New("--server is required (e.g. --server http://localhost:7070)")
	}
	authClient := rpc.Auth(server)

	start, err := authClient.StartLogin(ctx, connect.NewRequest(&prosav1.StartLoginRequest{
		Hostname:          device.Hostname(),
		DeviceFingerprint: device.IDOnce(),
	}))
	if err != nil {
		return fmt.Errorf("start login rpc: %s", rpc.ConnectError(err))
	}
	msg := start.Msg

	fmt.Fprintln(os.Stdout)
	fmt.Fprintln(os.Stdout, "  prosa: open this URL and enter the code below")
	fmt.Fprintln(os.Stdout)
	fmt.Fprintf(os.Stdout, "    %s\n", styleURL.Render(msg.VerificationUri))
	fmt.Fprintf(os.Stdout, "    %s\n", styleUserCode.Render(msg.UserCode))
	fmt.Fprintln(os.Stdout)

	interval := time.Duration(msg.Interval) * time.Second
	if interval < time.Second {
		interval = 2 * time.Second
	}
	deadline := time.Now().Add(time.Duration(msg.ExpiresIn) * time.Second)

	for {
		if time.Now().After(deadline) {
			return errors.New("login expired before approval")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
		poll, err := authClient.PollLogin(ctx, connect.NewRequest(&prosav1.PollLoginRequest{
			DeviceCode: msg.DeviceCode,
		}))
		if err != nil {
			return fmt.Errorf("poll login rpc: %s", rpc.ConnectError(err))
		}
		switch poll.Msg.State {
		case prosav1.PollLoginResponse_STATE_PENDING:
			fmt.Fprintf(os.Stdout, "%s\r",
				styleSubtle.Render(fmt.Sprintf("  waiting for approval … (expires in %ds)",
					int(time.Until(deadline).Seconds()))))
		case prosav1.PollLoginResponse_STATE_APPROVED:
			if err := saveAuth(server, poll.Msg); err != nil {
				return err
			}
			fmt.Fprintln(os.Stdout)
			fmt.Fprintf(os.Stdout, "  %s logged in as %s\n",
				lipgloss.NewStyle().Foreground(lipgloss.Color("46")).Render("✓"),
				device.Hostname())
			return nil
		case prosav1.PollLoginResponse_STATE_DENIED:
			return errors.New("login denied")
		case prosav1.PollLoginResponse_STATE_EXPIRED:
			return errors.New("login expired")
		}
	}
}

func saveAuth(server string, msg *prosav1.PollLoginResponse) error {
	return rpc.SaveAuth(rpc.AuthFile{
		Server:   rpc.NormalizeServerURL(server),
		DeviceID: msg.DeviceId,
		Token:    msg.Token,
	})
}

// (loginCtxFor is unused but kept as a sentinel for future device-code
// timeout extensions.)
var _ = context.Background
