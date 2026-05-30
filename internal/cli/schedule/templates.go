package schedule

import (
	"bytes"
	"embed"
	"fmt"
	"text/template"
)

//go:embed templates/*.tmpl
var templatesFS embed.FS

// renderTemplate executes the named embedded template against data and
// returns the produced bytes. The template name is the path inside the
// templates/ directory (e.g. "templates/sync.plist.tmpl").
func renderTemplate(name string, data any) ([]byte, error) {
	body, err := templatesFS.ReadFile(name)
	if err != nil {
		return nil, fmt.Errorf("embed read %s: %w", name, err)
	}
	tmpl, err := template.New(name).Parse(string(body))
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", name, err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return nil, fmt.Errorf("execute %s: %w", name, err)
	}
	return buf.Bytes(), nil
}
