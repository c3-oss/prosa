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

func TestNormalizeSortDir(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		raw    string
		sortBy string
		want   string
		isErr  bool
	}{
		{"started_at default", "", "started_at", "DESC", false},
		{"total_tokens default", "", "total_tokens", "DESC", false},
		{"agent default", "", "agent", "ASC", false},
		{"project default", "", "project", "ASC", false},
		{"device default", "", "device", "ASC", false},
		{"explicit asc", "asc", "started_at", "ASC", false},
		{"explicit desc", "desc", "agent", "DESC", false},
		{"case insensitive", "DESC", "started_at", "DESC", false},
		{"invalid", "up", "started_at", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := normalizeSortDir(tc.raw, tc.sortBy)
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
