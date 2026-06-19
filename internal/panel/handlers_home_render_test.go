package panel

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
)

type fakeSessionsService struct {
	prosav1connect.UnimplementedSessionsServiceHandler
	listResponse   *prosav1.ListResponse
	children       map[string][]*prosav1.Session
	onList         func(*prosav1.ListRequest)
	onListChildren func(*prosav1.ListChildrenRequest)
}

func (s fakeSessionsService) List(_ context.Context, req *connect.Request[prosav1.ListRequest]) (*connect.Response[prosav1.ListResponse], error) {
	if s.onList != nil {
		s.onList(req.Msg)
	}
	if s.listResponse != nil {
		return connect.NewResponse(s.listResponse), nil
	}
	return connect.NewResponse(&prosav1.ListResponse{TotalCount: 42}), nil
}

func (s fakeSessionsService) ListChildren(_ context.Context, req *connect.Request[prosav1.ListChildrenRequest]) (*connect.Response[prosav1.ListChildrenResponse], error) {
	if s.onListChildren != nil {
		s.onListChildren(req.Msg)
	}
	return connect.NewResponse(&prosav1.ListChildrenResponse{
		Sessions: s.children[req.Msg.ParentId],
	}), nil
}

type fakeDevicesService struct {
	prosav1connect.UnimplementedDevicesServiceHandler
}

func (fakeDevicesService) List(context.Context, *connect.Request[prosav1.DevicesServiceListRequest]) (*connect.Response[prosav1.DevicesServiceListResponse], error) {
	return connect.NewResponse(&prosav1.DevicesServiceListResponse{
		Devices: []*prosav1.Device{{Id: "dev-1", FriendlyName: "Laptop"}},
	}), nil
}

type fakeAnalyticsService struct {
	prosav1connect.UnimplementedAnalyticsServiceHandler
}

func (fakeAnalyticsService) GetReport(_ context.Context, req *connect.Request[prosav1.GetReportRequest]) (*connect.Response[prosav1.GetReportResponse], error) {
	row := func(vals ...string) *prosav1.AnalyticsRow { return &prosav1.AnalyticsRow{Values: vals} }
	canned := map[string]*prosav1.GetReportResponse{
		"tools": {Headers: []string{"TOOL", "USES", "SESSIONS"}, Rows: []*prosav1.AnalyticsRow{row("Read", "10", "3")}},
		"models": {Headers: []string{"MODEL", "SESSIONS"}, Rows: []*prosav1.AnalyticsRow{
			row("claude-opus-4-5", "2"), row("gpt-5-codex", "1"),
		}},
		"errors": {Headers: []string{"STARTED", "AGENT", "PROJECT", "SESSION"}, Rows: []*prosav1.AnalyticsRow{
			row("2026-05-30 09:00", "claude-code", "github.com/c3-oss/prosa", "sess-1"),
		}},
		"usage": {Headers: []string{"AGENT", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "EST_COST_USD"}, Rows: []*prosav1.AnalyticsRow{
			row("claude-code", "2", "2", "1500", "1200", "300", "0", "0.1200"),
		}},
		"projects": {Headers: []string{"PROJECT", "AGENT", "SESSIONS"}, Rows: []*prosav1.AnalyticsRow{
			row("proj-a", "claude-code", "3"), row("proj-b", "codex", "2"),
		}},
		"heatmap": {Headers: []string{"DATE", "AGENT", "SESSIONS"}, Rows: []*prosav1.AnalyticsRow{
			row("2026-05-30", "claude-code", "3"),
		}},
		"usage_by_model": {Headers: []string{"MODEL", "SESSIONS", "TOTAL", "INPUT", "OUTPUT", "EST_COST_USD"}, Rows: []*prosav1.AnalyticsRow{
			row("claude-opus-4-5", "2", "1500", "1200", "300", "0.1200"),
		}},
		"errors_by_model": {Headers: []string{"MODEL", "SESSIONS"}, Rows: []*prosav1.AnalyticsRow{
			row("claude-opus-4-5", "2"), row("gpt-5-codex", "1"),
		}},
		"hours": {Headers: []string{"HOUR", "SESSIONS"}, Rows: []*prosav1.AnalyticsRow{
			row("09", "5"), row("14", "3"),
		}},
		"usage_by_day": {
			Headers: []string{"DAY", "MODEL", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "CACHE_READ", "CACHE_CREATION"},
			Rows: []*prosav1.AnalyticsRow{
				row("2026-05-30", "claude-opus-4-5", "2", "2", "1500", "1200", "300", "0", "0", "0"),
			},
		},
		"punchcard": {Headers: []string{"DOW", "HOUR", "SESSIONS"}, Rows: []*prosav1.AnalyticsRow{
			row("6", "09", "3"), row("2", "14", "1"),
		}},
		"durations": {Headers: []string{"BUCKET", "SESSIONS"}, Rows: []*prosav1.AnalyticsRow{
			row("<5m", "2"), row("1-2h", "1"),
		}},
		"duration_stats": {Headers: []string{"MEDIAN_S", "P90_S", "AVG_S", "MAX_S"}, Rows: []*prosav1.AnalyticsRow{
			row("600", "8640", "3408", "10800"),
		}},
		"subagents": {Headers: []string{"AGENT", "PARENTS", "CHILDREN", "MAX_FANOUT"}, Rows: []*prosav1.AnalyticsRow{
			row("claude-code", "1", "2", "2"),
		}},
		"profiles": {Headers: []string{"DEVICE", "AGENT", "PROFILE", "SESSIONS"}, Rows: []*prosav1.AnalyticsRow{
			row("Laptop", "claude-code", "default", "3"), row("Laptop", "codex", "work", "2"),
		}},
		"usage_by_hour": {
			Headers: []string{"HOUR", "MODEL", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "CACHE_READ", "CACHE_CREATION"},
			Rows: []*prosav1.AnalyticsRow{
				row("09", "claude-opus-4-5", "2", "2", "1500", "1200", "300", "0", "0", "0"),
				row("14", "gpt-5-codex", "1", "1", "500", "400", "100", "0", "0", "0"),
			},
		},
		"subagent_usage_by_day": {
			Headers: []string{"DAY", "KIND", "MODEL", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "CACHE_READ", "CACHE_CREATION"},
			Rows: []*prosav1.AnalyticsRow{
				row("2026-05-30", "direct", "claude-opus-4-5", "2", "2", "1500", "1200", "300", "0", "0", "0"),
				row("2026-05-30", "subagent", "claude-opus-4-5", "2", "2", "500", "400", "100", "0", "0", "0"),
			},
		},
		"subagent_parents": {Headers: []string{"STARTED", "AGENT", "PROJECT", "SESSION", "CHILDREN"}, Rows: []*prosav1.AnalyticsRow{
			row("2026-05-30 09:00", "claude-code", "github.com/c3-oss/prosa", "sess-1", "2"),
		}},
		"profile_usage": {
			Headers: []string{"DEVICE", "AGENT", "PROFILE", "MODEL", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "CACHE_READ", "CACHE_CREATION", "LAST_ACTIVITY"},
			Rows: []*prosav1.AnalyticsRow{
				row("Laptop", "claude-code", "default", "claude-opus-4-5", "3", "3", "1500", "1200", "300", "0", "0", "0", "2026-05-30 09:00"),
				row("Laptop", "codex", "work", "gpt-5-codex", "2", "2", "500", "400", "100", "0", "0", "0", "2026-05-31 14:00"),
			},
		},
		"profiles_by_day": {Headers: []string{"DAY", "AGENT", "PROFILE", "SESSIONS"}, Rows: []*prosav1.AnalyticsRow{
			row("2026-05-30", "claude-code", "default", "3"), row("2026-05-31", "codex", "work", "2"),
		}},
	}
	if resp, ok := canned[req.Msg.Report]; ok {
		return connect.NewResponse(resp), nil
	}
	return connect.NewResponse(&prosav1.GetReportResponse{}), nil
}

// TestHomeRendersIssuesAndCharts drives the real handleHome against a fake
// upstream and asserts the new Issues section and charts render. Because
// html/template renders a missing map key as empty (no error), this is what
// catches a handler↔template key mismatch — the template-parse test cannot.
func TestHomeRendersIssuesAndCharts(t *testing.T) {
	mux := http.NewServeMux()
	var (
		mu       sync.Mutex
		listReqs []*prosav1.ListRequest
	)
	sp, sh := prosav1connect.NewSessionsServiceHandler(fakeSessionsService{
		onList: func(req *prosav1.ListRequest) {
			mu.Lock()
			defer mu.Unlock()
			listReqs = append(listReqs, &prosav1.ListRequest{
				Profiles: append([]string(nil), req.Profiles...),
			})
		},
	})
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

	req := httptest.NewRequest(http.MethodGet, "/?profile=work", nil)
	req.AddCookie(cookieFor(t, p, "owner@example.com"))
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	body := rec.Body.String()

	for _, want := range []string{
		">Issues<",                            // section heading
		">Hour of day<",                       // chart 4
		"Tokens &amp; cost per model",         // chart 2 heading (escaped &)
		">Projects<",                          // chart 3
		"error rate",                          // new KPI
		`data-chart="hour-of-day"`,            // hour-of-day chart container
		`data-chart="cost-donut"`,             // cost donut chart container
		"cost-legend",                         // donut legend
		"/sessions?session=sess-1",            // actionable recent issue link
		"peak ",                               // hour peak label
		"42",                                  // sessions KPI
		">Activity trend<",                    // daily trend card
		`data-chart="activity-trend"`,         // trend chart container
		"kpi-delta",                           // vs-previous-window badge
		"vs previous 30d",                     // delta badge tooltip
		`name="profile" value="work" checked`, // selected profile dropdown option
	} {
		require.Contains(t, body, want, "home page should render %q", want)
	}
	require.NotEmpty(t, listReqs)
	for _, req := range listReqs {
		require.Equal(t, []string{"work"}, req.Profiles)
	}

	// The old dumb Errors table must be gone.
	require.NotContains(t, body, "latest 20 sessions matching error heuristic")
}

// TestProfilesRendersDashboard drives the real handleProfiles against a fake
// upstream and asserts the KPI strip, charts, and enriched table render.
func TestProfilesRendersDashboard(t *testing.T) {
	mux := http.NewServeMux()
	sp, sh := prosav1connect.NewSessionsServiceHandler(fakeSessionsService{})
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

	req := httptest.NewRequest(http.MethodGet, "/profiles", nil)
	req.AddCookie(cookieFor(t, p, "owner@example.com"))
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	body := rec.Body.String()

	for _, want := range []string{
		"active profiles",                  // KPI strip
		"sessions outside default",         // KPI strip
		">Sessions per profile<",           // trend card
		"Tokens &amp; cost per profile",    // usage card
		">By device<",                      // table card
		`data-chart="profile-trend"`,       // trend chart island
		"claude-code·default",              // agent·profile chart label
		"codex·work",                       // agent·profile chart label
		"/sessions?device=Laptop&last=30d", // table device link
		"/sessions?profile=work&last=30d",  // table profile link
		"2026-05-31 14:00",                 // last seen cell
		`action="/profiles"`,               // filter drawer posts back here
		`name="profile" value="work"`,      // profile dropdown option
		"40%",                              // 2 of 5 sessions outside default
	} {
		require.Contains(t, body, want, "profiles page should render %q", want)
	}
}
