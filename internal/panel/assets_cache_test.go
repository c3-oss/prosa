package panel

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/buildinfo"
)

func TestAssetPathUsesBuildVersion(t *testing.T) {
	restoreBuildInfo(t)
	buildinfo.Version = "v1.2.3"
	buildinfo.Commit = "abc123"

	require.Equal(t, "/assets/v1.2.3/style.css", assetPath("style.css"))
	require.Equal(t, "/assets/v1.2.3/css/tokens.css", assetPath("/css/tokens.css"))
}

func TestAssetPathFallsBackToCommitForDevBuilds(t *testing.T) {
	restoreBuildInfo(t)
	buildinfo.Version = "dev"
	buildinfo.Commit = "abc/123"

	require.Equal(t, "/assets/abc-123/style.css", assetPath("style.css"))
}

func TestAssetHandlerCachesVersionedAssets(t *testing.T) {
	restoreBuildInfo(t)
	buildinfo.Version = "v9.9.9"
	buildinfo.Commit = "abc123"

	p := newAssetTestPanel(t)

	first := httptest.NewRecorder()
	p.mux.ServeHTTP(first, httptest.NewRequest(http.MethodGet, assetPath("style.css"), nil))
	require.Equal(t, http.StatusOK, first.Code)
	require.Equal(t, "public, max-age=31536000, immutable", first.Header().Get("Cache-Control"))
	require.NotEmpty(t, first.Header().Get("ETag"))

	second := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, assetPath("style.css"), nil)
	req.Header.Set("If-None-Match", first.Header().Get("ETag"))
	p.mux.ServeHTTP(second, req)
	require.Equal(t, http.StatusNotModified, second.Code)
}

func TestAssetHandlerRevalidatesUnversionedAssets(t *testing.T) {
	restoreBuildInfo(t)
	buildinfo.Version = "v9.9.9"
	buildinfo.Commit = "abc123"

	p := newAssetTestPanel(t)

	rr := httptest.NewRecorder()
	p.mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/assets/style.css", nil))
	require.Equal(t, http.StatusOK, rr.Code)
	require.Equal(t, "no-cache", rr.Header().Get("Cache-Control"))
	require.NotEmpty(t, rr.Header().Get("ETag"))
}

func TestAssetHandlerDoesNotImmutableCacheDevVersion(t *testing.T) {
	restoreBuildInfo(t)
	buildinfo.Version = "dev"
	buildinfo.Commit = "none"

	p := newAssetTestPanel(t)

	rr := httptest.NewRecorder()
	p.mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, assetPath("style.css"), nil))
	require.Equal(t, http.StatusOK, rr.Code)
	require.Equal(t, "no-cache", rr.Header().Get("Cache-Control"))
}

func restoreBuildInfo(t *testing.T) {
	t.Helper()
	version, commit, buildDate := buildinfo.Version, buildinfo.Commit, buildinfo.BuildDate
	t.Cleanup(func() {
		buildinfo.Version = version
		buildinfo.Commit = commit
		buildinfo.BuildDate = buildDate
	})
}

func newAssetTestPanel(t *testing.T) *Panel {
	t.Helper()
	p, err := New(Config{
		ServerURL:     "http://server.test",
		AdminToken:    "secret",
		CookieKey:     strings.Repeat("0", 64),
		OwnerEmails:   []string{"owner@example.com"},
		ListenAddr:    ":0",
		PublicBaseURL: "http://panel.test",
	})
	require.NoError(t, err)
	return p
}
