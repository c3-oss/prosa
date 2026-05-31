package projectlabel

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func TestNormalize(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"git@github.com:movaincentivo/iac.git", "movaincentivo/iac"},
		{"git@github.com:movaincentivo/iac", "movaincentivo/iac"},
		{"https://github.com/movaincentivo/iac.git", "movaincentivo/iac"},
		{"https://github.com/movaincentivo/iac", "movaincentivo/iac"},
		{"http://gitlab.example.com/foo/bar.git", "foo/bar"},
		{"ssh://git@github.com/movaincentivo/iac.git", "movaincentivo/iac"},
		{"https://gitlab.com/group/sub/repo.git", "group/sub/repo"},
		{"  git@github.com:owner/repo.git  ", "owner/repo"},
		{"", ""},
		{"not-a-remote", "not-a-remote"},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			require.Equal(t, c.want, Normalize(c.in))
		})
	}
}

func TestLabelPrefersMarker(t *testing.T) {
	marker := "movaincentivo"
	remote := "git@github.com:other/repo.git"
	path := "/Users/me/Projects/other"
	sess := session.Session{
		ProjectMarker: &marker,
		ProjectRemote: &remote,
		ProjectPath:   &path,
	}
	require.Equal(t, "movaincentivo", Label(sess))
}

func TestLabelFallsBackToNormalizedRemote(t *testing.T) {
	remote := "git@github.com:movaincentivo/iac.git"
	path := "/Users/me/Projects/iac"
	sess := session.Session{
		ProjectRemote: &remote,
		ProjectPath:   &path,
	}
	require.Equal(t, "movaincentivo/iac", Label(sess))
}

func TestLabelFallsBackToBasename(t *testing.T) {
	path := "/Users/me/Projects/movaincentivo/iac"
	sess := session.Session{
		ProjectPath: &path,
	}
	require.Equal(t, "iac", Label(sess))
}

func TestLabelUnscopedWhenNothingPresent(t *testing.T) {
	require.Equal(t, Unscoped, Label(session.Session{}))
}

func TestLabelUnscopedWhenAllEmpty(t *testing.T) {
	empty := ""
	sess := session.Session{
		ProjectMarker: &empty,
		ProjectRemote: &empty,
		ProjectPath:   &empty,
	}
	require.Equal(t, Unscoped, Label(sess))
}

func TestLabelSkipsRootPath(t *testing.T) {
	root := "/"
	sess := session.Session{ProjectPath: &root}
	require.Equal(t, Unscoped, Label(sess))
}

func TestLabelFallsBackToRemoteWhenMarkerEmpty(t *testing.T) {
	empty := ""
	remote := "git@github.com:owner/repo.git"
	sess := session.Session{
		ProjectMarker: &empty,
		ProjectRemote: &remote,
	}
	require.Equal(t, "owner/repo", Label(sess))
}
