package render

import "github.com/charmbracelet/lipgloss"

// Semantic palette from docs/cli/rendering-contract.md. Hex values are
// resolved in truecolor when the terminal supports it; Lipgloss falls
// back to the nearest 256-color index automatically when it doesn't.
const (
	ColorMuted   = lipgloss.Color("#8A8F98")
	ColorRail    = lipgloss.Color("#3A3F46")
	ColorAccent  = lipgloss.Color("#8AB4D6")
	ColorDevice  = lipgloss.Color("#7FB3C8")
	ColorAgent   = lipgloss.Color("#D6B97A")
	ColorProject = lipgloss.Color("#8CBF88")
	ColorActive  = lipgloss.Color("#D7827E")
	ColorError   = lipgloss.Color("#D7827E")
)

var (
	StyleMuted   = lipgloss.NewStyle().Foreground(ColorMuted)
	StyleRail    = lipgloss.NewStyle().Foreground(ColorRail)
	StyleAccent  = lipgloss.NewStyle().Foreground(ColorAccent)
	StyleDevice  = lipgloss.NewStyle().Foreground(ColorDevice)
	StyleAgent   = lipgloss.NewStyle().Foreground(ColorAgent)
	StyleProject = lipgloss.NewStyle().Foreground(ColorProject)
	StyleActive  = lipgloss.NewStyle().Foreground(ColorActive).Bold(true)
	StyleMatch   = lipgloss.NewStyle().Foreground(ColorAgent).Underline(true)
	StyleSuccess = lipgloss.NewStyle().Foreground(ColorProject)
	StyleSkipped = lipgloss.NewStyle().Foreground(ColorMuted)
	StyleWarning = lipgloss.NewStyle().Foreground(ColorAgent)
	StyleError   = lipgloss.NewStyle().Foreground(ColorError)
	StyleHeader  = lipgloss.NewStyle().Bold(true)
)
