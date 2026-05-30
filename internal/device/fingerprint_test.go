package device

import (
	"testing"

	"github.com/stretchr/testify/require"
)

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
