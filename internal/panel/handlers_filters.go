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
