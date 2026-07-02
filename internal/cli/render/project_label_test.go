package render

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func TestNormalizeRemote(t *testing.T) {
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
			require.Equal(t, c.want, NormalizeRemote(c.in))
		})
	}
}

func TestProjectLabelPrefersMarker(t *testing.T) {
	marker := "movaincentivo"
	remote := "git@github.com:other/repo.git"
	projectPath := "/Users/me/Projects/other"
	sess := session.Session{
		ProjectMarker: &marker,
		ProjectRemote: &remote,
		ProjectPath:   &projectPath,
	}
	require.Equal(t, "movaincentivo", projectLabel(sess))
}

func TestProjectLabelFallsBackToNormalizedRemote(t *testing.T) {
	remote := "git@github.com:movaincentivo/iac.git"
	projectPath := "/Users/me/Projects/iac"
	sess := session.Session{
		ProjectRemote: &remote,
		ProjectPath:   &projectPath,
	}
	require.Equal(t, "movaincentivo/iac", projectLabel(sess))
}

func TestProjectLabelFallsBackToBasename(t *testing.T) {
	projectPath := "/Users/me/Projects/movaincentivo/iac"
	sess := session.Session{
		ProjectPath: &projectPath,
	}
	require.Equal(t, "iac", projectLabel(sess))
}

func TestProjectLabelUnscopedWhenNothingPresent(t *testing.T) {
	require.Equal(t, unscopedProjectLabel, projectLabel(session.Session{}))
}

func TestProjectLabelUnscopedWhenAllEmpty(t *testing.T) {
	empty := ""
	sess := session.Session{
		ProjectMarker: &empty,
		ProjectRemote: &empty,
		ProjectPath:   &empty,
	}
	require.Equal(t, unscopedProjectLabel, projectLabel(sess))
}

func TestProjectLabelSkipsRootPath(t *testing.T) {
	root := "/"
	sess := session.Session{ProjectPath: &root}
	require.Equal(t, unscopedProjectLabel, projectLabel(sess))
}

func TestProjectLabelFallsBackToRemoteWhenMarkerEmpty(t *testing.T) {
	empty := ""
	remote := "git@github.com:owner/repo.git"
	sess := session.Session{
		ProjectMarker: &empty,
		ProjectRemote: &remote,
	}
	require.Equal(t, "owner/repo", projectLabel(sess))
}
