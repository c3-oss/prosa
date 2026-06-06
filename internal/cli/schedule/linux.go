package schedule

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/c3-oss/prosa/internal/paths"
)

const (
	linuxUnit    = "prosa-sync"
	linuxUnitRel = ".config/systemd/user"
)

type linuxPaths struct {
	unitDir     string
	servicePath string
	timerPath   string
}

func newLinuxPaths() (linuxPaths, error) {
	home, err := paths.UserHome()
	if err != nil {
		return linuxPaths{}, err
	}
	dir := filepath.Join(home, linuxUnitRel)
	return linuxPaths{
		unitDir:     dir,
		servicePath: filepath.Join(dir, linuxUnit+".service"),
		timerPath:   filepath.Join(dir, linuxUnit+".timer"),
	}, nil
}

type linuxServiceData struct {
	Binary string
}

type linuxTimerData struct {
	IntervalSpec string // systemd format, e.g. "15min"
}

func linuxSchedulerInstall(ctx context.Context, binaryPath string, interval time.Duration) error {
	l, err := newLinuxPaths()
	if err != nil {
		return err
	}
	if interval < time.Minute {
		return fmt.Errorf("interval too short: %s (minimum 1m)", interval)
	}
	if err := os.MkdirAll(l.unitDir, 0o755); err != nil {
		return fmt.Errorf("create systemd user dir: %w", err)
	}
	service, err := renderTemplate("templates/sync.service.tmpl", linuxServiceData{
		Binary: binaryPath,
	})
	if err != nil {
		return err
	}
	if err := os.WriteFile(l.servicePath, service, 0o644); err != nil {
		return fmt.Errorf("write service: %w", err)
	}
	timer, err := renderTemplate("templates/sync.timer.tmpl", linuxTimerData{
		IntervalSpec: systemdSpec(interval),
	})
	if err != nil {
		return err
	}
	if err := os.WriteFile(l.timerPath, timer, 0o644); err != nil {
		return fmt.Errorf("write timer: %w", err)
	}
	if err := systemctl(ctx, "daemon-reload"); err != nil {
		return err
	}
	if err := systemctl(ctx, "enable", "--now", linuxUnit+".timer"); err != nil {
		return err
	}
	return nil
}

func linuxSchedulerUninstall(ctx context.Context) error {
	l, err := newLinuxPaths()
	if err != nil {
		return err
	}
	if _, err := os.Stat(l.timerPath); os.IsNotExist(err) {
		return nil
	}
	_ = systemctl(ctx, "disable", "--now", linuxUnit+".timer")
	for _, p := range []string{l.timerPath, l.servicePath} {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	_ = systemctl(ctx, "daemon-reload")
	return nil
}

func linuxSchedulerStatus(ctx context.Context) (State, error) {
	l, err := newLinuxPaths()
	if err != nil {
		return State{}, err
	}
	st := State{UnitPath: l.timerPath}
	body, err := os.ReadFile(l.timerPath)
	if os.IsNotExist(err) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	st.Installed = true
	if iv := extractTimerInterval(string(body)); iv > 0 {
		st.Interval = iv
	}
	return st, nil
}

func systemctl(ctx context.Context, args ...string) error {
	full := append([]string{"--user"}, args...)
	cmd := exec.CommandContext(ctx, "systemctl", full...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s: %w: %s",
			strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// systemdSpec converts a Go time.Duration to systemd's OnUnitActiveSec
// shorthand. We emit minutes (floored to 1) — covers the realistic
// range and stays readable in the unit file.
func systemdSpec(d time.Duration) string {
	mins := int(d.Minutes())
	if mins < 1 {
		mins = 1
	}
	return fmt.Sprintf("%dmin", mins)
}

// extractTimerInterval parses OnUnitActiveSec=<spec> out of the timer
// body. Tolerates whitespace and trailing comments; returns 0 when the
// key is missing or unparseable.
func extractTimerInterval(body string) time.Duration {
	for _, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(raw)
		const k = "OnUnitActiveSec="
		if !strings.HasPrefix(line, k) {
			continue
		}
		v := strings.TrimSpace(line[len(k):])
		if i := strings.Index(v, "#"); i >= 0 {
			v = strings.TrimSpace(v[:i])
		}
		if strings.HasSuffix(v, "min") {
			n, err := strconv.Atoi(strings.TrimSuffix(v, "min"))
			if err == nil {
				return time.Duration(n) * time.Minute
			}
		} else if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return 0
}
