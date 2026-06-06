package cli

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/cli/render"
	"github.com/c3-oss/prosa/internal/store"
)

func TestResolveProjectScopeExplicitProject(t *testing.T) {
	scope := ResolveProjectScope(context.Background(), globalFlags{Project: "prosa"}, nil)

	require.Equal(t, render.ScopeScoped, scope.Scope)
	require.Equal(t, "prosa", scope.Label)
	require.Equal(t, "prosa", scope.Project)

	filter := store.SessionFilter{}
	scope.ApplySessionFilter(&filter)
	require.NotNil(t, filter.ProjectMatch)
	require.Equal(t, "prosa", *filter.ProjectMatch)

	reportReq := &prosav1.GetReportRequest{}
	scope.ApplyReportRequest(reportReq)
	require.Equal(t, "prosa", reportReq.ProjectMatch)

	searchReq := &prosav1.SearchRequest{}
	scope.ApplySearchRequest(searchReq)
	require.Empty(t, searchReq.ProjectRemote)
	require.Empty(t, searchReq.ProjectMarker)
}

func TestResolveProjectScopeAll(t *testing.T) {
	scope := ResolveProjectScope(context.Background(), globalFlags{All: true}, nil)

	require.Equal(t, render.ScopeAll, scope.Scope)
	require.Empty(t, scope.Label)

	filter := store.SessionFilter{}
	scope.ApplySessionFilter(&filter)
	require.Nil(t, filter.ProjectMatch)
	require.Nil(t, filter.ProjectExact)
	require.Nil(t, filter.ProjectRemote)
	require.Nil(t, filter.ProjectMarker)
}

func TestResolveProjectScopeAutoDetectedPath(t *testing.T) {
	root := filepath.Join(t.TempDir(), "prosa")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "sub"), 0o755))
	t.Chdir(filepath.Join(root, "sub"))

	s := seedProjects(t, root)
	scope := ResolveProjectScope(context.Background(), globalFlags{}, s)

	require.Equal(t, render.ScopeScoped, scope.Scope)
	require.Equal(t, root, scope.Label)
	require.True(t, scope.Match.Found)
	require.Equal(t, root, scope.Match.Path)

	filter := store.SessionFilter{}
	scope.ApplySessionFilter(&filter)
	require.NotNil(t, filter.ProjectExact)
	require.Equal(t, root, *filter.ProjectExact)

	reportReq := &prosav1.GetReportRequest{}
	scope.ApplyReportRequest(reportReq)
	require.Equal(t, root, reportReq.ProjectPath)

	searchReq := &prosav1.SearchRequest{}
	scope.ApplySearchRequest(searchReq)
	require.Empty(t, searchReq.ProjectRemote)
	require.Empty(t, searchReq.ProjectMarker)
}

func TestProjectScopeAppliesRemoteIdentity(t *testing.T) {
	scope := ProjectScope{Match: Match{Remote: "git@example.com:c3/prosa.git", Found: true}}

	filter := store.SessionFilter{}
	scope.ApplySessionFilter(&filter)
	require.NotNil(t, filter.ProjectRemote)
	require.Equal(t, "git@example.com:c3/prosa.git", *filter.ProjectRemote)

	reportReq := &prosav1.GetReportRequest{}
	scope.ApplyReportRequest(reportReq)
	require.Equal(t, "git@example.com:c3/prosa.git", reportReq.ProjectRemote)

	searchReq := &prosav1.SearchRequest{}
	scope.ApplySearchRequest(searchReq)
	require.Equal(t, "git@example.com:c3/prosa.git", searchReq.ProjectRemote)
}

func TestProjectScopeAppliesMarkerIdentity(t *testing.T) {
	scope := ProjectScope{Match: Match{Marker: "c3-oss/prosa", Found: true}}

	filter := store.SessionFilter{}
	scope.ApplySessionFilter(&filter)
	require.NotNil(t, filter.ProjectMarker)
	require.Equal(t, "c3-oss/prosa", *filter.ProjectMarker)

	reportReq := &prosav1.GetReportRequest{}
	scope.ApplyReportRequest(reportReq)
	require.Equal(t, "c3-oss/prosa", reportReq.ProjectMarker)

	searchReq := &prosav1.SearchRequest{}
	scope.ApplySearchRequest(searchReq)
	require.Equal(t, "c3-oss/prosa", searchReq.ProjectMarker)
}
