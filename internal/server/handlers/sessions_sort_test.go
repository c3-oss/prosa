package handlers

import "testing"

func TestNormalizeListSort(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in    string
		want  string
		isErr bool
	}{
		{"", "started_at", false},
		{"started_at", "started_at", false},
		{"total_tokens", "total_tokens", false},
		{"agent", "agent", false},
		{"project", "project", false},
		{"device", "device", false},
		{"cost", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			t.Parallel()
			got, err := normalizeListSort(tc.in)
			if tc.isErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}
