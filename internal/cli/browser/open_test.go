package browser

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCommandForURL(t *testing.T) {
	t.Parallel()
	url := "https://example.com/authorize"
	cases := []struct {
		goos     string
		wantName string
		wantArgs []string
	}{
		{goos: "darwin", wantName: "open", wantArgs: []string{url}},
		{goos: "linux", wantName: "xdg-open", wantArgs: []string{url}},
		{goos: "freebsd", wantName: "xdg-open", wantArgs: []string{url}},
		{goos: "windows", wantName: "rundll32", wantArgs: []string{"url.dll,FileProtocolHandler", url}},
	}
	for _, tc := range cases {
		t.Run(tc.goos, func(t *testing.T) {
			t.Parallel()
			name, args := commandForURL(tc.goos, url)
			require.Equal(t, tc.wantName, name)
			require.Equal(t, tc.wantArgs, args)
		})
	}
}
