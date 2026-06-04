package panel

import "net/url"

// sortDefaultDir is the first-click direction for each sortable column.
var sortDefaultDir = map[string]string{
	"started_at":   "desc",
	"total_tokens": "desc",
	"cost":         "desc",
	"agent":        "asc",
	"project":      "asc",
	"device":       "asc",
}

var sessionsSortableCols = []string{
	"started_at", "total_tokens", "agent", "project", "device", "cost",
}

// resolveSessionsSort maps URL sort/dir to the active column and direction.
// Empty sort means the default view (started_at, newest first).
func resolveSessionsSort(sortBy, dir string) (activeSort, activeDir string) {
	if sortBy == "" {
		return "started_at", defaultSortDir("started_at")
	}
	if dir == "" {
		return sortBy, defaultSortDir(sortBy)
	}
	return sortBy, dir
}

func defaultSortDir(col string) string {
	if d, ok := sortDefaultDir[col]; ok {
		return d
	}
	return "desc"
}

func oppositeSortDir(dir string) string {
	if dir == "asc" {
		return "desc"
	}
	return "asc"
}

// nextSortURL returns the query suffix for the next click on column col.
// Cycle: inactive -> sort with default dir; active+default -> reverse;
// active+reversed -> clear (default started_at desc, no sort params).
func nextSortURL(base url.Values, col, activeSort, activeDir string) string {
	q := stripQuery(base, "page", "sort", "dir", "session")
	def := defaultSortDir(col)
	if activeSort != col {
		return encodeSortQuery(q, col, "")
	}
	if activeDir == def {
		return encodeSortQuery(q, col, oppositeSortDir(def))
	}
	return q.Encode()
}

func encodeSortQuery(q url.Values, sort, dir string) string {
	out := cloneValues(q)
	out.Del("sort")
	out.Del("dir")
	if sort != "" {
		out.Set("sort", sort)
		if dir != "" {
			out.Set("dir", dir)
		}
	}
	return out.Encode()
}

func buildSessionsSortURLs(base url.Values, activeSort, activeDir string) map[string]string {
	out := make(map[string]string, len(sessionsSortableCols))
	for _, col := range sessionsSortableCols {
		out[col] = "?" + nextSortURL(base, col, activeSort, activeDir)
	}
	return out
}

func buildSessionsSortArrows(activeSort, activeDir string) map[string]string {
	out := make(map[string]string, len(sessionsSortableCols))
	for _, col := range sessionsSortableCols {
		out[col] = sortArrow(activeSort, activeDir, col)
	}
	return out
}

func sortArrow(activeSort, activeDir, col string) string {
	if activeSort != col {
		return ""
	}
	if activeDir == "asc" {
		return "▴"
	}
	return "▾"
}
