package cli

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/importer"
)

func TestShouldInlinePush(t *testing.T) {
	push := &pusher{}

	tests := []struct {
		name      string
		push      *pusher
		res       importer.ImportResult
		importErr error
		want      bool
	}{
		{
			name: "clean imported result pushes inline",
			push: push,
			res:  importer.ImportResult{SessionID: "s1"},
			want: true,
		},
		{
			name: "nil pusher (no auth) never pushes",
			push: nil,
			res:  importer.ImportResult{SessionID: "s1"},
			want: false,
		},
		{
			name:      "import error never pushes",
			push:      push,
			res:       importer.ImportResult{SessionID: "s1"},
			importErr: errors.New("parse failed"),
			want:      false,
		},
		{
			name: "skipped result never pushes",
			push: push,
			res:  importer.ImportResult{SessionID: "s1", Skipped: true},
			want: false,
		},
		{
			name: "synthetic marker (hermes state.db) is deferred to catch-up",
			push: push,
			res:  importer.ImportResult{SessionID: "hermes-state-abc", Synthetic: true},
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.want, shouldInlinePush(tt.push, tt.res, tt.importErr))
		})
	}
}
