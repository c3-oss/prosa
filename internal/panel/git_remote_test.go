package panel

import "testing"

func TestGitRemoteLink(t *testing.T) {
	t.Parallel()
	tests := []struct {
		raw      string
		wantLbl  string
		wantURL  string
		wantProv string
	}{
		{
			raw:      "git@github.com:c3-oss/prosa.git",
			wantLbl:  "c3-oss/prosa",
			wantURL:  "https://github.com/c3-oss/prosa",
			wantProv: "github",
		},
		{
			raw:      "https://gitlab.com/mz-codes/mz-operator-1.git",
			wantLbl:  "mz-codes/mz-operator-1",
			wantURL:  "https://gitlab.com/mz-codes/mz-operator-1",
			wantProv: "gitlab",
		},
		{
			raw:     "/Users/me/proj",
			wantLbl: "~/proj",
		},
		{
			raw:     "/Users/upsetbit/Library/Application Support/CodexBar/ClaudeProbe",
			wantLbl: "~/Library/Application Support/CodexBar/ClaudeProbe",
		},
		{
			raw:     "/home/upsetbit/proj",
			wantLbl: "~/proj",
		},
		{
			raw:     "/Users/me",
			wantLbl: "~",
		},
		{
			raw:     "",
			wantLbl: "(unscoped)",
		},
	}
	for _, tc := range tests {
		t.Run(tc.raw, func(t *testing.T) {
			t.Parallel()
			lbl, u, p := gitRemoteLink(tc.raw, "", "")
			if lbl != tc.wantLbl || u != tc.wantURL || p != tc.wantProv {
				t.Fatalf("gitRemoteLink(%q) = (%q,%q,%q), want (%q,%q,%q)",
					tc.raw, lbl, u, p, tc.wantLbl, tc.wantURL, tc.wantProv)
			}
		})
	}
}
