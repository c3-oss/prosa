package render

import (
	"fmt"
	"strings"
)

// ContextScope names the project-scoping state shown in the context
// line. Helpers below build the textual segment per state so call
// sites don't reimplement the formatting.
type ContextScope int

const (
	// ScopeScoped means a project was detected (auto from cwd, or set
	// explicitly via --project). Label carries the project name.
	ScopeScoped ContextScope = iota
	// ScopeAll means the caller passed --all, opting out of scoping.
	ScopeAll
	// ScopeProjectNotDetected means scoping was attempted but the cwd
	// is not part of any known project. Output falls back to all
	// projects with a discoverable hint.
	ScopeProjectNotDetected
)

// ContextLineOptions is the input to ContextLine and SearchContextLine.
// Command is "prosa" or "search" (callers fill it). Source is
// "local" or "remote". Exactly one of Last / Since / Between is
// non-empty at call time: Last is the rolling-window token ("7d",
// "12h"); Since is a YYYY-MM-DD anchor; Between is a pre-formatted
// "YYYY-MM-DD and YYYY-MM-DD" range string. The renderer adds the
// appropriate "last " / "since " / "between " prefix.
// Query is only used by the search variant; ignored by ContextLine.
// UniformProject / UniformDevice carry values dropped from the rows by
// cardinality-1 suppression; they render as trailing segments so the
// information survives the collapsed column.
type ContextLineOptions struct {
	Command        string
	Source         string
	Scope          ContextScope
	ScopeLabel     string
	Last           string
	Since          string
	Between        string
	Query          string
	UniformProject string
	UniformDevice  string
}

// ContextLine builds the stderr context anchor printed before timeline
// or analytics output. Examples:
//
//	prosa · local · scoped to prosa · last 7d
//	prosa · local · all projects · last 7d
//	prosa · local · project not detected · showing all projects · last 7d
//	prosa · remote · scoped to prosa · last 30d
//	prosa · local · all projects · last 1d · project c3-oss/prosa · device tbox
func ContextLine(opts ContextLineOptions) string {
	parts := []string{
		opts.Command,
		opts.Source,
		scopeSegment(opts),
	}
	tail := lastSegment2(opts)
	if tail != "" {
		parts = append(parts, tail)
	}
	if opts.UniformProject != "" {
		parts = append(parts, "project "+opts.UniformProject)
	}
	if opts.UniformDevice != "" {
		parts = append(parts, "device "+opts.UniformDevice)
	}
	return strings.Join(parts, " · ")
}

// SearchContextLine is the variant used by `prosa search`. It carries
// the query in quotes instead of the time window.
//
//	search · local · scoped to prosa · "sqlite"
func SearchContextLine(opts ContextLineOptions) string {
	parts := []string{
		opts.Command,
		opts.Source,
		scopeSegment(opts),
	}
	if opts.Query != "" {
		parts = append(parts, fmt.Sprintf("%q", opts.Query))
	}
	return strings.Join(parts, " · ")
}

func scopeSegment(opts ContextLineOptions) string {
	switch opts.Scope {
	case ScopeAll:
		return "all projects"
	case ScopeProjectNotDetected:
		return "project not detected"
	case ScopeScoped:
		if opts.ScopeLabel == "" {
			return "all projects"
		}
		return "scoped to " + opts.ScopeLabel
	}
	return "all projects"
}

func lastSegment2(opts ContextLineOptions) string {
	window := windowSegment(opts)
	if opts.Scope == ScopeProjectNotDetected {
		if window == "" {
			return "showing all projects"
		}
		return "showing all projects · " + window
	}
	return window
}

func windowSegment(opts ContextLineOptions) string {
	if opts.Between != "" {
		return "between " + opts.Between
	}
	if opts.Since != "" {
		return "since " + opts.Since
	}
	if opts.Last == "" {
		return ""
	}
	return "last " + opts.Last
}
