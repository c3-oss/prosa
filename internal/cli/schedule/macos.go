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
	macLabel    = "com.c3-oss.prosa.sync"
	macPlistRel = "Library/LaunchAgents/com.c3-oss.prosa.sync.plist"
	macLogRel   = "Library/Logs/prosa"
)

type macPaths struct {
	plistPath string
	logDir    string
}

func newMacOSPaths() (macPaths, error) {
	home, err := paths.UserHome()
	if err != nil {
		return macPaths{}, err
	}
	return macPaths{
		plistPath: filepath.Join(home, macPlistRel),
		logDir:    filepath.Join(home, macLogRel),
	}, nil
}

type macTmplData struct {
	Label      string
	Binary     string
	IntervalS  int
	StdoutPath string
	StderrPath string
}

func macSchedulerInstall(ctx context.Context, binaryPath string, interval time.Duration) error {
	m, err := newMacOSPaths()
	if err != nil {
		return err
	}
	if interval < time.Minute {
		return fmt.Errorf("interval too short: %s (minimum 1m)", interval)
	}
	if err := os.MkdirAll(filepath.Dir(m.plistPath), 0o755); err != nil {
		return fmt.Errorf("create LaunchAgents dir: %w", err)
	}
	if err := os.MkdirAll(m.logDir, 0o755); err != nil {
		return fmt.Errorf("create log dir: %w", err)
	}
	body, err := renderTemplate("templates/sync.plist.tmpl", macTmplData{
		Label:      macLabel,
		Binary:     binaryPath,
		IntervalS:  int(interval.Seconds()),
		StdoutPath: filepath.Join(m.logDir, "sync.out.log"),
		StderrPath: filepath.Join(m.logDir, "sync.err.log"),
	})
	if err != nil {
		return err
	}
	if err := os.WriteFile(m.plistPath, body, 0o644); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}
	// Re-install: best-effort bootout, then load -w. Ignoring bootout
	// failure handles the "wasn't loaded yet" case without polluting
	// the success path.
	_ = exec.CommandContext(ctx, "launchctl", "bootout", "gui/"+macUID(), m.plistPath).Run()
	cmd := exec.CommandContext(ctx, "launchctl", "load", "-w", m.plistPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl load: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func macSchedulerUninstall(ctx context.Context) error {
	m, err := newMacOSPaths()
	if err != nil {
		return err
	}
	if _, err := os.Stat(m.plistPath); os.IsNotExist(err) {
		return nil
	}
	_ = exec.CommandContext(ctx, "launchctl", "bootout", "gui/"+macUID(), m.plistPath).Run()
	if err := os.Remove(m.plistPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func macSchedulerStatus(ctx context.Context) (State, error) {
	m, err := newMacOSPaths()
	if err != nil {
		return State{}, err
	}
	st := State{UnitPath: m.plistPath}
	body, err := os.ReadFile(m.plistPath)
	if os.IsNotExist(err) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	st.Installed = true
	if iv := extractStartInterval(string(body)); iv > 0 {
		st.Interval = time.Duration(iv) * time.Second
	}
	return st, nil
}

func macUID() string {
	return strconv.Itoa(os.Getuid())
}

// extractStartInterval reads StartInterval from a plist body; returns 0 when missing or unparseable.
func extractStartInterval(body string) int {
	const k = "<key>StartInterval</key>"
	i := strings.Index(body, k)
	if i < 0 {
		return 0
	}
	rest := body[i+len(k):]
	j := strings.Index(rest, "<integer>")
	if j < 0 {
		return 0
	}
	rest = rest[j+len("<integer>"):]
	e := strings.Index(rest, "</integer>")
	if e < 0 {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(rest[:e]))
	if err != nil {
		return 0
	}
	return n
}
