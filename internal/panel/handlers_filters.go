package panel

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

// pickDeviceNames pulls every "device" entry from the query string,
// dropping empties. Both ?device=A&device=B and the legacy single
// ?device=A reach the same multi-value slice here, so callers can
// always set ListRequest.DeviceNames.
func pickDeviceNames(q url.Values) []string {
	vals := q["device"]
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		v = strings.TrimSpace(v)
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

// parseWindow turns "12h" / "7d" / "30d" (CLI vernacular) into a
// duration. Default 7d.
func parseWindow(s string) (time.Duration, error) {
	if s == "" {
		return 7 * 24 * time.Hour, nil
	}
	if strings.HasSuffix(s, "h") {
		n, err := strconv.Atoi(strings.TrimSuffix(s, "h"))
		if err != nil {
			return 0, err
		}
		return time.Duration(n) * time.Hour, nil
	}
	if strings.HasSuffix(s, "d") {
		n, err := strconv.Atoi(strings.TrimSuffix(s, "d"))
		if err != nil {
			return 0, err
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	return 0, fmt.Errorf("unrecognized window %q (try 12h, 7d, 30d)", s)
}

func analyticsRequest(report string, since, until time.Time, q url.Values) *prosav1.GetReportRequest {
	req := &prosav1.GetReportRequest{
		Report:      report,
		Since:       timestamppb.New(since),
		Until:       timestamppb.New(until),
		DeviceNames: pickDeviceNames(q),
	}
	req.ProjectMatch = q.Get("project")
	req.Agent = q.Get("agent")
	return req
}

// parseDashboardWindow resolves the dashboard's ?last= filter into time
// bounds. Defaults to 30d; the "all" sentinel maps to a -100y lower bound.
func parseDashboardWindow(q url.Values, now time.Time) (lastRaw string, since, until time.Time, err error) {
	lastRaw = q.Get("last")
	if lastRaw == "" {
		lastRaw = "30d"
	}
	until = now
	if lastRaw == "all" {
		since = now.Add(-100 * 365 * 24 * time.Hour)
		return lastRaw, since, until, nil
	}
	window, err := parseWindow(lastRaw)
	if err != nil {
		return lastRaw, since, until, err
	}
	return lastRaw, now.Add(-window), until, nil
}

// dashboardReportRequest builds the GetReportRequest shared by the home and
// insights dashboards. agent/project_match are single-valued on the wire, so a
// multi-select falls back to "any" and the cards reflect the full window.
func dashboardReportRequest(report string, since, until time.Time, agents, projects, devices []string) *prosav1.GetReportRequest {
	req := &prosav1.GetReportRequest{
		Report:      report,
		Since:       timestamppb.New(since),
		Until:       timestamppb.New(until),
		DeviceNames: devices,
	}
	if len(agents) == 1 {
		req.Agent = agents[0]
	}
	if len(projects) == 1 {
		req.ProjectMatch = projects[0]
	}
	return req
}

// buildDashboardActiveFilters renders one removal chip per active filter,
// pointing at basePath ("/" or "/insights").
func buildDashboardActiveFilters(q url.Values, basePath, last string, agents, projects, devices []string) []activeFilter {
	var out []activeFilter
	mk := func(label, value string, removeQuery url.Values) activeFilter {
		removeQuery.Del("session")
		removeURL := basePath
		if encoded := removeQuery.Encode(); encoded != "" {
			removeURL += "?" + encoded
		}
		return activeFilter{Label: label, Value: value, RemoveURL: removeURL}
	}
	if last != "" && last != "30d" {
		next := cloneValues(q)
		next.Del("last")
		out = append(out, mk("Window", last, next))
	}
	for _, a := range agents {
		next := cloneValues(q)
		removeFromMulti(next, "agent", a)
		out = append(out, mk("Agent", a, next))
	}
	for _, p := range projects {
		next := cloneValues(q)
		removeFromMulti(next, "project", p)
		out = append(out, mk("Project", p, next))
	}
	for _, d := range devices {
		next := cloneValues(q)
		removeFromMulti(next, "device", d)
		out = append(out, mk("Device", d, next))
	}
	return out
}
