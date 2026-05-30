package render

import "github.com/charmbracelet/lipgloss"

const (
	ColorMuted   = lipgloss.Color("245")
	ColorRail    = lipgloss.Color("238")
	ColorAccent  = lipgloss.Color("110")
	ColorDevice  = lipgloss.Color("109")
	ColorAgent   = lipgloss.Color("179")
	ColorProject = lipgloss.Color("108")
	ColorActive  = lipgloss.Color("174")
	ColorError   = lipgloss.Color("174")
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
