package panel

import (
	"fmt"
	"html/template"
	"net/url"
	"strings"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

// projectDisplay is the resolved label + optional git host link for a session
// project field.
type projectDisplay struct {
	Label    string
	URL      string
	Provider string // "github" | "gitlab" | ""
}

// gitRemoteLink picks the best project string from marker/remote/path and, when
// it looks like a GitHub or GitLab remote, returns owner/repo plus a canonical
// HTTPS URL and provider name.
func gitRemoteLink(marker, remote, path string) (label, linkURL, provider string) {
	raw := strings.TrimSpace(marker)
	if raw == "" {
		raw = strings.TrimSpace(remote)
	}
	if raw == "" {
		raw = strings.TrimSpace(path)
	}
	if raw == "" {
		return "(unscoped)", "", ""
	}
	host, owner, repo, ok := parseGitRemote(raw)
	if !ok || owner == "" || repo == "" {
		return raw, "", ""
	}
	short := owner + "/" + repo
	switch host {
	case "github.com":
		return short, fmt.Sprintf("https://github.com/%s/%s", owner, repo), "github"
	case "gitlab.com":
		return short, fmt.Sprintf("https://gitlab.com/%s/%s", owner, repo), "gitlab"
	default:
		return raw, "", ""
	}
}

func parseGitRemote(raw string) (host, owner, repo string, ok bool) {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimSuffix(raw, ".git")
	if raw == "" {
		return "", "", "", false
	}
	if strings.HasPrefix(raw, "git@") {
		rest := strings.TrimPrefix(raw, "git@")
		colon := strings.Index(rest, ":")
		if colon < 0 {
			return "", "", "", false
		}
		host = rest[:colon]
		pathPart := strings.Trim(rest[colon+1:], "/")
		return splitOwnerRepo(host, pathPart)
	}
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			return "", "", "", false
		}
		return splitOwnerRepo(u.Hostname(), strings.Trim(u.Path, "/"))
	}
	return "", "", "", false
}

func splitOwnerRepo(host, pathPart string) (string, string, string, bool) {
	segs := strings.Split(pathPart, "/")
	if len(segs) < 2 {
		return "", "", "", false
	}
	owner := segs[len(segs)-2]
	repo := segs[len(segs)-1]
	if owner == "" || repo == "" {
		return "", "", "", false
	}
	return host, owner, repo, true
}

func projectDisplayFromSession(s *prosav1.Session) projectDisplay {
	if s == nil {
		return projectDisplay{Label: "(unscoped)"}
	}
	label, linkURL, provider := gitRemoteLink(s.ProjectMarker, s.ProjectRemote, s.ProjectPath)
	return projectDisplay{Label: label, URL: linkURL, Provider: provider}
}

func projectDisplayFromLabel(label string) projectDisplay {
	l, u, p := gitRemoteLink(label, "", "")
	return projectDisplay{Label: l, URL: u, Provider: p}
}

// projectLink renders a project label with optional provider icon + hyperlink.
func projectLink(d projectDisplay) template.HTML {
	if d.Label == "" {
		d.Label = "(unscoped)"
	}
	if d.URL == "" {
		return template.HTML(template.HTMLEscapeString(d.Label))
	}
	icon := ""
	switch d.Provider {
	case "github":
		icon = iconGitHubSVG
	case "gitlab":
		icon = iconGitLabSVG
	}
	label := template.HTMLEscapeString(d.Label)
	href := template.HTMLEscapeString(d.URL)
	return template.HTML(fmt.Sprintf(
		`<a class="project-link" href="%s" target="_blank" rel="noopener">%s<span>%s</span></a>`,
		href, icon, label,
	))
}

const iconGitHubSVG = `<svg class="project-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`

const iconGitLabSVG = `<svg class="project-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 16 1.5 9.2l1.4-4.3L8 7.1l5.1-2.2 1.4 4.3L8 16z"/></svg>`
