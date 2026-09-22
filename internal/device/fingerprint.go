// Package device resolves the stable per-machine identity prosa uses for
// sessions.device_id and the server device row.
//
// The id is hex(sha256(hostname + "\x00" + machineID))[:16].
//
// On darwin the hostname is `scutil --get LocalHostName`, trimmed. When
// scutil fails or returns empty, it is os.Hostname() with a trailing
// ".local" removed. On linux and every other platform it is os.Hostname()
// with a trailing ".local" removed.
//
// macOS machineID is the IOPlatformUUID parsed from
// `ioreg -rd1 -c IOPlatformExpertDevice`.
// Linux machineID is /etc/machine-id, or /var/lib/dbus/machine-id when
// that file is missing.
// Other platforms leave machineID empty; the hostname still yields an id.
//
// All public funcs return cached values after the first call so
// repeated importer invocations on the same process pay the cost once.
package device

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
)

var (
	once    sync.Once
	cached  resolved
	resolve = doResolve // overridable for tests

	// darwinLocalHostName is the raw stdout of `scutil --get LocalHostName`.
	// Tests replace it so hostname resolution does not spawn a process.
	darwinLocalHostName = execDarwinLocalHostName

	// osHostname is os.Hostname. Tests replace it.
	osHostname = os.Hostname
)

type resolved struct {
	id           string
	hostname     string
	friendly     string
	machineID    string
	resolveError error
}

// IDOnce returns the cached fingerprint, computing it on the first call.
// Errors during machineID resolution are swallowed — the id always falls
// back to a hash of just the hostname so importers never block on missing
// platform plumbing.
func IDOnce() string {
	once.Do(func() { cached = resolve() })
	return cached.id
}

// Hostname returns the hostname mixed into the fingerprint. Cached.
// On darwin this is the LocalHostName when scutil succeeds. Otherwise,
// and on every other platform, it is os.Hostname() with a trailing
// ".local" removed.
func Hostname() string {
	once.Do(func() { cached = resolve() })
	return cached.hostname
}

// FriendlyName today is just the hostname; INTENT.md §6 promises a
// `prosa devices rename` flow in a later cut that overrides this.
func FriendlyName() string {
	once.Do(func() { cached = resolve() })
	return cached.friendly
}

// MachineID returns the raw machineID string used in the hash, or "" if
// the platform reader failed. Surfaced for debugging via `prosa devices`.
func MachineID() string {
	once.Do(func() { cached = resolve() })
	return cached.machineID
}

// Fingerprint computes hex(sha256(hostname + "\x00" + machineID))[:16].
// Exposed so tests can reproduce the id without going through the resolver.
func Fingerprint(hostname, machineID string) string {
	h := sha256.Sum256([]byte(hostname + "\x00" + machineID))
	return hex.EncodeToString(h[:])[:16]
}

func doResolve() resolved {
	host := resolveHostname(runtime.GOOS)
	mid, err := readMachineID()
	return resolved{
		id:           Fingerprint(host, mid),
		hostname:     host,
		friendly:     host,
		machineID:    mid,
		resolveError: err,
	}
}

// resolveHostname picks the hostname mixed into the fingerprint.
// goos is injectable so tests cover darwin without running on darwin.
func resolveHostname(goos string) string {
	if goos == "darwin" {
		if raw, err := darwinLocalHostName(); err == nil {
			if name := strings.TrimSpace(raw); name != "" {
				return name
			}
		}
	}
	host, _ := osHostname()
	return strings.TrimSuffix(host, ".local")
}

func execDarwinLocalHostName() (string, error) {
	out, err := exec.Command("scutil", "--get", "LocalHostName").Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func readMachineID() (string, error) {
	switch runtime.GOOS {
	case "darwin":
		return readMacIOPlatformUUID()
	case "linux":
		return readLinuxMachineID()
	default:
		return "", nil
	}
}

func readMacIOPlatformUUID() (string, error) {
	out, err := exec.Command("ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output()
	if err != nil {
		return "", err
	}
	// We're looking for: "IOPlatformUUID" = "BEEFCAFE-..."
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "IOPlatformUUID") {
			continue
		}
		idx := strings.Index(line, "=")
		if idx < 0 {
			continue
		}
		val := strings.TrimSpace(line[idx+1:])
		val = strings.Trim(val, "\" ")
		return val, nil
	}
	return "", nil
}

func readLinuxMachineID() (string, error) {
	for _, path := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		b, err := os.ReadFile(path)
		if err == nil {
			return strings.TrimSpace(string(b)), nil
		}
	}
	return "", nil
}
