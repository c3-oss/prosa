package panel

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
)

func TestSessionsGroupedFeedShowsParentsOnly(t *testing.T) {
	parent := pricedPanelSession("parent", "parent prompt", 1000)
	child := pricedPanelSession("child", "child prompt", 2000)
	unpriced := unpricedPanelSession("unpriced", "unpriced child")

	var listReqs []*prosav1.ListRequest
	var childReqs []*prosav1.ListChildrenRequest
	p := newPanelWithFakeSessions(t, fakeSessionsService{
		listResponse: &prosav1.ListResponse{
			Sessions:   []*prosav1.Session{parent},
			TotalCount: 1,
		},
		children: map[string][]*prosav1.Session{
			"parent": {child, unpriced},
		},
		onList: func(req *prosav1.ListRequest) {
			listReqs = append(listReqs, req)
		},
		onListChildren: func(req *prosav1.ListChildrenRequest) {
			childReqs = append(childReqs, req)
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/sessions", nil)
	req.AddCookie(cookieFor(t, p, "owner@example.com"))
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotEmpty(t, listReqs)
	require.True(t, listReqs[0].TopLevelOnly)
	require.Len(t, childReqs, 1)
	require.Equal(t, "parent", childReqs[0].ParentId)

	body := rec.Body.String()
	// The grouped feed is parent-only: the orchestrator appears with a
	// subagent count; its children are reached from the detail panel, not
	// rendered as feed rows. (Cost rollup itself is covered by
	// TestListSessionsSortedByCostUsesGroupedCost.)
	require.Contains(t, body, "parent prompt")
	require.Contains(t, body, "2 ⤵")
	require.NotContains(t, body, "child prompt")
	require.NotContains(t, body, "unpriced child")
}

func TestSessionsUngroupedFeedShowsFlatRows(t *testing.T) {
	parent := pricedPanelSession("parent", "parent prompt", 1000)
	child := pricedPanelSession("child", "child prompt", 2000)

	var childCalls int
	p := newPanelWithFakeSessions(t, fakeSessionsService{
		listResponse: &prosav1.ListResponse{
			Sessions:   []*prosav1.Session{parent, child},
			TotalCount: 2,
		},
		children: map[string][]*prosav1.Session{
			"parent": {child},
		},
		onListChildren: func(*prosav1.ListChildrenRequest) {
			childCalls++
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/sessions?group_subagents=off", nil)
	req.AddCookie(cookieFor(t, p, "owner@example.com"))
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, 0, childCalls)

	body := rec.Body.String()
	// Ungrouped (?group_subagents=off): parent and child are independent
	// feed rows; no children are fetched for a rollup.
	require.Contains(t, body, "parent prompt")
	require.Contains(t, body, "child prompt")
}

func TestListSessionsSortedByCostUsesGroupedCost(t *testing.T) {
	lowParent := pricedPanelSession("low-parent", "low parent", 1000)
	highChild := pricedPanelSession("high-child", "high child", 10000)
	midParent := pricedPanelSession("mid-parent", "mid parent", 5000)

	p := newPanelWithFakeSessions(t, fakeSessionsService{
		listResponse: &prosav1.ListResponse{
			Sessions:   []*prosav1.Session{midParent, lowParent},
			TotalCount: 2,
		},
		children: map[string][]*prosav1.Session{
			"low-parent": {highChild},
		},
	})

	got, total, pageCount, err := p.listSessionsSortedByCost(
		context.Background(),
		&prosav1.ListRequest{TopLevelOnly: true},
		1,
		10,
		"desc",
	)

	require.NoError(t, err)
	require.Equal(t, int64(2), total)
	require.Equal(t, 1, pageCount)
	require.Equal(t, []string{"low-parent", "mid-parent"}, panelSessionIDs(got))
}

func TestListSessionsSortedByCostUngroupedUsesOwnCost(t *testing.T) {
	lowParent := pricedPanelSession("low-parent", "low parent", 1000)
	highChild := pricedPanelSession("high-child", "high child", 10000)
	midParent := pricedPanelSession("mid-parent", "mid parent", 5000)

	var childCalls int
	p := newPanelWithFakeSessions(t, fakeSessionsService{
		listResponse: &prosav1.ListResponse{
			Sessions:   []*prosav1.Session{lowParent, midParent},
			TotalCount: 2,
		},
		children: map[string][]*prosav1.Session{
			"low-parent": {highChild},
		},
		onListChildren: func(*prosav1.ListChildrenRequest) {
			childCalls++
		},
	})

	got, total, pageCount, err := p.listSessionsSortedByCost(
		context.Background(),
		&prosav1.ListRequest{},
		1,
		10,
		"desc",
	)

	require.NoError(t, err)
	require.Equal(t, int64(2), total)
	require.Equal(t, 1, pageCount)
	require.Equal(t, []string{"mid-parent", "low-parent"}, panelSessionIDs(got))
	require.Equal(t, 0, childCalls)
}

func newPanelWithFakeSessions(t *testing.T, svc fakeSessionsService) *Panel {
	t.Helper()

	mux := http.NewServeMux()
	sp, sh := prosav1connect.NewSessionsServiceHandler(svc)
	mux.Handle(sp, sh)
	dp, dh := prosav1connect.NewDevicesServiceHandler(fakeDevicesService{})
	mux.Handle(dp, dh)
	ap, ah := prosav1connect.NewAnalyticsServiceHandler(fakeAnalyticsService{})
	mux.Handle(ap, ah)
	upstream := httptest.NewServer(mux)
	t.Cleanup(upstream.Close)

	p, err := New(Config{
		ServerURL:     upstream.URL,
		AdminToken:    "secret",
		CookieKey:     "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		OwnerEmails:   []string{"owner@example.com"},
		ListenAddr:    ":0",
		PublicBaseURL: "http://panel.test",
	})
	require.NoError(t, err)
	return p
}

func pricedPanelSession(id, prompt string, inputTokens int64) *prosav1.Session {
	return &prosav1.Session{
		Id:          id,
		Agent:       "claude-code",
		DeviceId:    "dev-1",
		FirstPrompt: prompt,
		Model:       "claude-fable-5",
		Usage: &prosav1.TokenUsage{
			TotalTokens: inputTokens,
			InputTokens: inputTokens,
		},
	}
}

func unpricedPanelSession(id, prompt string) *prosav1.Session {
	return &prosav1.Session{
		Id:          id,
		Agent:       "claude-code",
		DeviceId:    "dev-1",
		FirstPrompt: prompt,
		Model:       "not-a-real-model-name",
		Usage:       &prosav1.TokenUsage{TotalTokens: 1000, InputTokens: 1000},
	}
}

func panelSessionIDs(in []*prosav1.Session) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		out = append(out, s.Id)
	}
	return out
}
