package schedule

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestUnsupportedDispatch(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"install", installForGOOS(ctx, "windows", "/usr/local/bin/prosa", 15*time.Minute)},
		{"uninstall", uninstallForGOOS(ctx, "windows")},
	} {
		if tc.err == nil {
			t.Fatalf("%s should be unsupported", tc.name)
		}
		if !errors.Is(tc.err, ErrUnsupported) {
			t.Errorf("%s err = %v, want wrapped ErrUnsupported", tc.name, tc.err)
		}
	}
	_, err := statusForGOOS(ctx, "windows")
	if err == nil {
		t.Fatal("status should be unsupported")
	}
	if !errors.Is(err, ErrUnsupported) {
		t.Errorf("status err = %v, want wrapped ErrUnsupported", err)
	}
}

func TestRenderMacPlist(t *testing.T) {
	body, err := renderTemplate("templates/sync.plist.tmpl", macTmplData{
		Label:      "com.c3-oss.prosa.sync",
		Binary:     "/usr/local/bin/prosa",
		IntervalS:  900,
		StdoutPath: "/tmp/sync.out.log",
		StderrPath: "/tmp/sync.err.log",
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	s := string(body)
	wants := []string{
		"<string>com.c3-oss.prosa.sync</string>",
		"<string>/usr/local/bin/prosa</string>",
		"<integer>900</integer>",
		"<string>/tmp/sync.out.log</string>",
		"<string>/tmp/sync.err.log</string>",
		"<string>Background</string>",
	}
	for _, w := range wants {
		if !strings.Contains(s, w) {
			t.Errorf("plist missing %q\nbody:\n%s", w, s)
		}
	}
	if iv := extractStartInterval(s); iv != 900 {
		t.Errorf("extractStartInterval = %d, want 900", iv)
	}
}

func TestRenderLinuxUnits(t *testing.T) {
	svc, err := renderTemplate("templates/sync.service.tmpl", linuxServiceData{
		Binary: "/usr/local/bin/prosa",
	})
	if err != nil {
		t.Fatalf("service: %v", err)
	}
	if !strings.Contains(string(svc), "ExecStart=/usr/local/bin/prosa sync") {
		t.Errorf("service missing ExecStart:\n%s", svc)
	}

	timer, err := renderTemplate("templates/sync.timer.tmpl", linuxTimerData{
		IntervalSpec: "15min",
	})
	if err != nil {
		t.Fatalf("timer: %v", err)
	}
	if !strings.Contains(string(timer), "OnUnitActiveSec=15min") {
		t.Errorf("timer missing OnUnitActiveSec:\n%s", timer)
	}
	if iv := extractTimerInterval(string(timer)); iv != 15*time.Minute {
		t.Errorf("extractTimerInterval = %s, want 15m", iv)
	}
}

func TestSystemdSpec(t *testing.T) {
	cases := []struct {
		in   time.Duration
		want string
	}{
		{15 * time.Minute, "15min"},
		{time.Hour, "60min"},
		{30 * time.Second, "1min"},
	}
	for _, c := range cases {
		got := systemdSpec(c.in)
		if got != c.want {
			t.Errorf("systemdSpec(%s) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestExtractStartIntervalMissing(t *testing.T) {
	if iv := extractStartInterval("<?xml?><plist><dict></dict></plist>"); iv != 0 {
		t.Errorf("expected 0 when key absent, got %d", iv)
	}
}

func TestExtractTimerIntervalGoDuration(t *testing.T) {
	body := "[Timer]\nOnUnitActiveSec=2h30m\n"
	if iv := extractTimerInterval(body); iv != 2*time.Hour+30*time.Minute {
		t.Errorf("extractTimerInterval(2h30m) = %s, want 2h30m", iv)
	}
}
