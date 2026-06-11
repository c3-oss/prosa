package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/cli/rpc"
)

func newDevicesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "devices",
		Short: "Inspect and manage devices registered on the server",
	}
	cmd.AddCommand(newDevicesListCmd())
	cmd.AddCommand(newDevicesRenameCmd())
	cmd.AddCommand(newDevicesRevokeCmd())
	return cmd
}

func newDevicesListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List every device the server knows about",
		RunE:  runDevicesList,
	}
}

func newDevicesRenameCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rename <id|self> <new-name>",
		Short: "Set this device's display name",
		Args:  cobra.ExactArgs(2),
		RunE:  runDevicesRename,
	}
}

func newDevicesRevokeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "revoke <id|self>",
		Short: "Revoke a device's server access",
		Args:  cobra.ExactArgs(1),
		RunE:  runDevicesRevoke,
	}
}

func runDevicesList(cmd *cobra.Command, _ []string) error {
	ctx := rpc.ContextOrBackground(cmd.Context())
	client, err := loadDevicesClient()
	if err != nil {
		return err
	}
	resp, err := client.List(ctx, connect.NewRequest(&prosav1.DevicesServiceListRequest{}))
	if err != nil {
		return fmt.Errorf("list rpc: %s", rpc.ConnectError(err))
	}
	if g.JSON {
		enc := json.NewEncoder(os.Stdout)
		for _, d := range resp.Msg.Devices {
			if err := enc.Encode(deviceJSON(d)); err != nil {
				return err
			}
		}
		return nil
	}
	return renderDeviceTable(os.Stdout, resp.Msg.Devices, IsInteractive())
}

func runDevicesRename(cmd *cobra.Command, args []string) error {
	ctx := rpc.ContextOrBackground(cmd.Context())
	client, err := loadDevicesClient()
	if err != nil {
		return err
	}
	resp, err := client.Rename(ctx, connect.NewRequest(&prosav1.RenameRequest{
		Id: args[0], FriendlyName: args[1],
	}))
	if err != nil {
		return fmt.Errorf("rename rpc: %s", rpc.ConnectError(err))
	}
	fmt.Fprintf(os.Stdout, "renamed %s → %q\n", resp.Msg.Device.Id, resp.Msg.Device.FriendlyName)
	return nil
}

func runDevicesRevoke(cmd *cobra.Command, args []string) error {
	ctx := rpc.ContextOrBackground(cmd.Context())
	client, err := loadDevicesClient()
	if err != nil {
		return err
	}
	if _, err := client.Revoke(ctx, connect.NewRequest(&prosav1.RevokeRequest{Id: args[0]})); err != nil {
		return fmt.Errorf("revoke rpc: %s", rpc.ConnectError(err))
	}
	fmt.Fprintf(os.Stdout, "revoked %s\n", args[0])
	if args[0] == "self" {
		// Drop the local auth file too — next command will need a fresh login.
		_ = rpc.DeleteAuth()
	}
	return nil
}

// loadDevicesClient is the single auth gateway for every devices sub-command.
func loadDevicesClient() (devicesClient, error) {
	a, err := rpc.LoadAuth()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("not logged in — run `prosa login --server <URL>` first")
		}
		return nil, err
	}
	return rpc.Devices(a.Server, a.Token), nil
}

type devicesClient interface {
	List(ctx context.Context, req *connect.Request[prosav1.DevicesServiceListRequest]) (*connect.Response[prosav1.DevicesServiceListResponse], error)
	Rename(ctx context.Context, req *connect.Request[prosav1.RenameRequest]) (*connect.Response[prosav1.RenameResponse], error)
	Revoke(ctx context.Context, req *connect.Request[prosav1.RevokeRequest]) (*connect.Response[prosav1.RevokeResponse], error)
}

var (
	devHdrStyle = render.StyleHeader.Foreground(render.ColorMuted)
	devCellRev  = render.StyleError
	devCellOK   = render.StyleSuccess
)

func renderDeviceTable(w *os.File, devices []*prosav1.Device, interactive bool) error {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	header := []string{"ID", "FRIENDLY", "HOSTNAME", "SESSIONS", "LAST SYNC", "STATE"}
	if interactive {
		styled := make([]string, len(header))
		for i, h := range header {
			styled[i] = devHdrStyle.Render(h)
		}
		fmt.Fprintln(tw, joinTabs(styled))
	} else {
		fmt.Fprintln(tw, joinTabs(header))
	}
	for _, d := range devices {
		state := devCellOK.Render("active")
		if d.Revoked {
			state = devCellRev.Render("revoked")
		}
		if !interactive {
			if d.Revoked {
				state = "revoked"
			} else {
				state = "active"
			}
		}
		last := "-"
		if d.LastSync != nil {
			last = d.LastSync.AsTime().Local().Format(time.RFC3339)
		}
		row := []string{
			d.Id, d.FriendlyName, d.Hostname,
			fmt.Sprintf("%d", d.Sessions), last, state,
		}
		fmt.Fprintln(tw, joinTabs(row))
	}
	return tw.Flush()
}

func joinTabs(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += "\t"
		}
		out += p
	}
	return out
}

func deviceJSON(d *prosav1.Device) map[string]any {
	out := map[string]any{
		"id":            d.Id,
		"friendly_name": d.FriendlyName,
		"hostname":      d.Hostname,
		"sessions":      d.Sessions,
		"revoked":       d.Revoked,
	}
	if d.FingerprintedAt != nil {
		out["fingerprinted_at"] = d.FingerprintedAt.AsTime().Format(time.RFC3339)
	}
	if d.LastSync != nil {
		out["last_sync"] = d.LastSync.AsTime().Format(time.RFC3339)
	}
	return out
}
