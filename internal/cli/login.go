package cli

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/cli/browser"
	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/cli/rpc"
	"github.com/c3-oss/prosa/internal/device"
)

// pkceLogin runs the PKCE + localhost-callback flow against `server`.
// onPending is invoked once after BeginLogin succeeds with the authorize
// URL; onApproved runs after ExchangeCode and SaveAuth succeed.
func pkceLogin(ctx context.Context, server string, onPending func(url string), onApproved func()) error {
	verifier, challenge, clientState, err := newPKCEPair()
	if err != nil {
		return err
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("bind callback listener: %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	redirectURI := fmt.Sprintf("http://127.0.0.1:%d/callback", port)

	type callbackResult struct {
		code  string
		state string
	}
	resultCh := make(chan callbackResult, 1)
	errCh := make(chan error, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if e := q.Get("error"); e != "" {
			errCh <- fmt.Errorf("authorization denied: %s", e)
			return
		}
		code := q.Get("code")
		state := q.Get("state")
		if code == "" || state == "" {
			http.Error(w, "missing code or state", http.StatusBadRequest)
			errCh <- errors.New("callback missing code or state")
			return
		}
		if state != clientState {
			http.Error(w, "state mismatch", http.StatusBadRequest)
			errCh <- errors.New("callback state mismatch")
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!doctype html><html><body><p>Authorization complete. You can close this tab.</p></body></html>`))
		resultCh <- callbackResult{code: code, state: state}
	})

	srv := &http.Server{Handler: mux}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("callback server: %w", err)
		}
	}()
	defer func() {
		shutCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()

	authClient := rpc.Auth(server)
	begin, err := authClient.BeginLogin(ctx, connect.NewRequest(&prosav1.BeginLoginRequest{
		Hostname:          device.Hostname(),
		DeviceFingerprint: device.IDOnce(),
		CodeChallenge:     challenge,
		RedirectUri:       redirectURI,
		ClientState:       clientState,
	}))
	if err != nil {
		return fmt.Errorf("begin login rpc: %s", rpc.ConnectError(err))
	}
	msg := begin.Msg
	if onPending != nil {
		onPending(msg.AuthorizeUrl)
	}
	if err := browser.Open(ctx, msg.AuthorizeUrl); err != nil {
		slog.Debug("browser open failed", "err", err)
	}

	expires := time.Duration(msg.ExpiresIn) * time.Second
	if expires <= 0 {
		expires = 15 * time.Minute
	}
	timer := time.NewTimer(expires)
	defer timer.Stop()

	var cb callbackResult
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errCh:
		return err
	case cb = <-resultCh:
	case <-timer.C:
		return errors.New("login expired before approval")
	}

	exchange, err := authClient.ExchangeCode(ctx, connect.NewRequest(&prosav1.ExchangeCodeRequest{
		Code:         cb.code,
		CodeVerifier: verifier,
		RedirectUri:  redirectURI,
	}))
	if err != nil {
		return fmt.Errorf("exchange code rpc: %s", rpc.ConnectError(err))
	}
	if err := saveAuth(server, exchange.Msg.Token, exchange.Msg.DeviceId); err != nil {
		return err
	}
	if onApproved != nil {
		onApproved()
	}
	return nil
}

func newPKCEPair() (verifier, challenge, clientState string, err error) {
	vb := make([]byte, 32)
	if _, err = rand.Read(vb); err != nil {
		return "", "", "", err
	}
	verifier = base64.RawURLEncoding.EncodeToString(vb)
	h := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(h[:])

	sb := make([]byte, 16)
	if _, err = rand.Read(sb); err != nil {
		return "", "", "", err
	}
	clientState = hex.EncodeToString(sb)
	return verifier, challenge, clientState, nil
}

var loginServerFlag string

func newLoginCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "login",
		Short: "Authenticate this device against a prosa-server",
		Long: "Starts PKCE login: opens the panel authorize URL in your browser,\n" +
			"waits for you to click Authorize, then saves the bearer to\n" +
			"~/.config/prosa/auth.json for sync and remote queries.",
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
	styleURL    = render.StyleAccent
	styleSubtle = render.StyleMuted
)

func runLogin(cmd *cobra.Command, _ []string) error {
	ctx := rpc.ContextOrBackground(cmd.Context())
	server := loginServerFlag
	if server == "" {
		return errors.New("--server is required (e.g. --server http://localhost:7070)")
	}
	interactive := IsInteractive()
	onPending := func(url string) {
		if interactive {
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
		} else {
			fmt.Fprintf(os.Stdout, "device\t%s\n", device.Hostname())
			fmt.Fprintf(os.Stdout, "server\t%s\n", server)
			fmt.Fprintf(os.Stdout, "auth_url\t%s\n", url)
			fmt.Fprintln(os.Stdout, "status\twaiting_for_approval")
		}
	}
	onApproved := func() {
		if interactive {
			fmt.Fprint(os.Stdout, "\033[4F\033[J")
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
	return pkceLogin(ctx, server, onPending, onApproved)
}

func saveAuth(server, token, deviceID string) error {
	return rpc.SaveAuth(rpc.AuthFile{
		Server:   rpc.NormalizeServerURL(server),
		DeviceID: deviceID,
		Token:    token,
	})
}
