package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/cli/rpc"
	"github.com/c3-oss/prosa/internal/device"
)

// deviceLogin runs the OAuth device-code flow against `server`.
// onPending is invoked once after StartLogin succeeds (passes the
// verification URL + user code); onApproved is invoked once after
// PollLogin returns approved and SaveAuth succeeds. Both callbacks
// may be nil — the auth flow still runs to completion and the token
// is still persisted.
//
// Extracted so `prosa setup` can drive its own checklist UI around
// the same StartLogin → poll → SaveAuth lifecycle without printing
// the standalone `prosa login` header.
func deviceLogin(ctx context.Context, server string, onPending func(url, code string), onApproved func()) error {
	authClient := rpc.Auth(server)
	start, err := authClient.StartLogin(ctx, connect.NewRequest(&prosav1.StartLoginRequest{
		Hostname:          device.Hostname(),
		DeviceFingerprint: device.IDOnce(),
	}))
	if err != nil {
		return fmt.Errorf("start login rpc: %s", rpc.ConnectError(err))
	}
	msg := start.Msg
	if onPending != nil {
		onPending(msg.VerificationUri, msg.UserCode)
	}
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
			// keep waiting
		case prosav1.PollLoginResponse_STATE_APPROVED:
			if err := saveAuth(server, poll.Msg); err != nil {
				return err
			}
			if onApproved != nil {
				onApproved()
			}
			return nil
		case prosav1.PollLoginResponse_STATE_DENIED:
			return errors.New("login denied")
		case prosav1.PollLoginResponse_STATE_EXPIRED:
			return errors.New("login expired")
		}
	}
}

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
			if IsInteractive() {
				fmt.Fprintf(os.Stdout, "%s auth cleared\n", render.StyleSuccess.Render("✓"))
				return nil
			}
			fmt.Fprintln(os.Stdout, "logged out")
			return nil
		},
	}
}

var (
	styleUserCode = render.StyleHeader.Foreground(render.ColorAgent)
	styleURL      = render.StyleAccent
	styleSubtle   = render.StyleMuted
)

func runLogin(cmd *cobra.Command, _ []string) error {
	ctx := rpc.ContextOrBackground(cmd.Context())
	server := loginServerFlag
	if server == "" {
		return errors.New("--server is required (e.g. --server http://localhost:7070)")
	}
	interactive := IsInteractive()
	onPending := func(url, code string) {
		if interactive {
			// Checklist: device + server done, auth waiting, URL/code below.
			// On approval we move the cursor back to the `→ auth` line and
			// redraw the tail so the user never sees the "waiting" line
			// linger.
			fmt.Fprintln(os.Stdout, "prosa login")
			fmt.Fprintln(os.Stdout)
			fmt.Fprintf(os.Stdout, "%s device       %s\n", render.StyleSuccess.Render("✓"), device.Hostname())
			fmt.Fprintf(os.Stdout, "%s server       %s\n", render.StyleSuccess.Render("✓"), styleURL.Render(server))
			fmt.Fprintf(os.Stdout, "%s auth         %s\n",
				render.StyleAccent.Render("→"),
				styleSubtle.Render("waiting for browser approval"))
			fmt.Fprintln(os.Stdout)
			fmt.Fprintln(os.Stdout, styleSubtle.Render("Open this URL if the browser did not start:"))
			fmt.Fprintf(os.Stdout, "  %s\n", styleURL.Render(url))
			fmt.Fprintf(os.Stdout, "  %s\n", styleUserCode.Render(code))
		} else {
			fmt.Fprintf(os.Stdout, "device\t%s\n", device.Hostname())
			fmt.Fprintf(os.Stdout, "server\t%s\n", server)
			fmt.Fprintf(os.Stdout, "auth_url\t%s\n", url)
			fmt.Fprintf(os.Stdout, "user_code\t%s\n", code)
			fmt.Fprintln(os.Stdout, "status\twaiting_for_approval")
		}
	}
	onApproved := func() {
		if interactive {
			// Move cursor up past the URL block (4 lines: blank,
			// hint, URL, code) AND the auth-waiting line — 5 lines
			// total — then erase from cursor to end of screen and
			// re-emit the tail with auth marked done.
			fmt.Fprint(os.Stdout, "\033[5F\033[J")
			fmt.Fprintf(os.Stdout, "%s auth         %s\n",
				render.StyleSuccess.Render("✓"),
				render.StyleSuccess.Render("approved"))
			fmt.Fprintf(os.Stdout, "%s token        %s\n",
				render.StyleSuccess.Render("✓"),
				styleSubtle.Render("~/.config/prosa/auth.json"))
			fmt.Fprintln(os.Stdout)
			fmt.Fprintln(os.Stdout, styleSubtle.Render("ready"))
		} else {
			fmt.Fprintln(os.Stdout, "status\tapproved")
		}
	}
	return deviceLogin(ctx, server, onPending, onApproved)
}

func saveAuth(server string, msg *prosav1.PollLoginResponse) error {
	return rpc.SaveAuth(rpc.AuthFile{
		Server:   rpc.NormalizeServerURL(server),
		DeviceID: msg.DeviceId,
		Token:    msg.Token,
	})
}
