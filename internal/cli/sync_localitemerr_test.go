package cli

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLocalItemErr(t *testing.T) {
	importErr := errors.New("parse failed")
	pushErr := errors.New("push rpc: server 503")

	// Import error always wins, regardless of push outcome.
	require.Equal(t, importErr, localItemErr(importErr, pushImported, nil))
	require.Equal(t, importErr, localItemErr(importErr, pushFailed, pushErr))

	// Import ok + push genuinely failed → surface the push error so the row
	// isn't a clean check mark.
	require.Equal(t, pushErr, localItemErr(nil, pushFailed, pushErr))

	// Import ok + push fine / skipped / remote-unavailable → no row error.
	require.NoError(t, localItemErr(nil, pushImported, nil))
	require.NoError(t, localItemErr(nil, pushAlreadyHashed, nil))
	require.NoError(t, localItemErr(nil, pushSkippedNoUsage, nil))
	require.NoError(t, localItemErr(nil, pushSkippedRemoteUnavailable, nil))
}
