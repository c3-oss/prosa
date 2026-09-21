package rawlock

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestHoldBlocksUntilRelease(t *testing.T) {
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))

	release, err := Hold("session-1")
	require.NoError(t, err)

	done := make(chan struct{})
	go func() {
		rel, err := Hold("session-1")
		if err != nil {
			t.Errorf("second hold: %v", err)
			close(done)
			return
		}
		rel()
		close(done)
	}()

	select {
	case <-done:
		t.Fatal("second hold acquired the lock while the first still held it")
	case <-time.After(50 * time.Millisecond):
	}

	release()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("second hold did not acquire the lock after release")
	}
}

func TestHoldRejectsUnsafeSessionID(t *testing.T) {
	t.Setenv("PROSA_HOME", filepath.Join(t.TempDir(), "prosa-home"))
	_, err := Hold("../escape")
	require.Error(t, err)
}
