package device

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

var errScutil = errors.New("scutil failed")

func TestFingerprintIsStableAndShort(t *testing.T) {
	id1 := Fingerprint("laptop", "BEEFCAFE-1234")
	id2 := Fingerprint("laptop", "BEEFCAFE-1234")
	require.Equal(t, id1, id2)
	require.Len(t, id1, 16)
	require.Regexp(t, `^[0-9a-f]{16}$`, id1)
}

func TestFingerprintIsHostnameSensitive(t *testing.T) {
	a := Fingerprint("laptop", "M1")
	b := Fingerprint("desktop", "M1")
	require.NotEqual(t, a, b)
}

func TestFingerprintIsMachineIDSensitive(t *testing.T) {
	a := Fingerprint("laptop", "M1")
	b := Fingerprint("laptop", "M2")
	require.NotEqual(t, a, b)
}

func TestFingerprintEmptyMachineIDStillStable(t *testing.T) {
	// Fallback path: no platform reader yields an ID. Hostname alone
	// must still produce a stable, non-empty fingerprint.
	a := Fingerprint("laptop", "")
	b := Fingerprint("laptop", "")
	require.Equal(t, a, b)
	require.NotEmpty(t, a)
}

func TestIDOnceMatchesFingerprintOfResolvedInputs(t *testing.T) {
	id := IDOnce()
	expected := Fingerprint(Hostname(), MachineID())
	require.Equal(t, expected, id)
}

func TestResolveHostname(t *testing.T) {
	origLocal := darwinLocalHostName
	origHost := osHostname
	t.Cleanup(func() {
		darwinLocalHostName = origLocal
		osHostname = origHost
	})

	tests := []struct {
		name   string
		goos   string
		local  func() (string, error)
		host   func() (string, error)
		want   string
		scutil bool
	}{
		{
			name:   "darwin scutil success",
			goos:   "darwin",
			local:  func() (string, error) { return "  tbox\n", nil },
			host:   func() (string, error) { return "192.168.0.19", nil },
			want:   "tbox",
			scutil: true,
		},
		{
			name:   "darwin scutil failure falls back",
			goos:   "darwin",
			local:  func() (string, error) { return "", errScutil },
			host:   func() (string, error) { return "192.168.0.19", nil },
			want:   "192.168.0.19",
			scutil: true,
		},
		{
			name:   "darwin empty scutil falls back and strips .local",
			goos:   "darwin",
			local:  func() (string, error) { return " \n", nil },
			host:   func() (string, error) { return "studio.local", nil },
			want:   "studio",
			scutil: true,
		},
		{
			name:   "linux keeps os hostname and strips one .local",
			goos:   "linux",
			local:  func() (string, error) { return "ignored", nil },
			host:   func() (string, error) { return "box.local", nil },
			want:   "box",
			scutil: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			called := false
			darwinLocalHostName = func() (string, error) {
				called = true
				return tt.local()
			}
			osHostname = tt.host
			require.Equal(t, tt.want, resolveHostname(tt.goos))
			require.Equal(t, tt.scutil, called)
		})
	}
}
