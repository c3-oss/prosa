package cli

import (
	"fmt"
	"strings"

	"github.com/c3-oss/prosa/internal/importers/antigravity"
	"github.com/c3-oss/prosa/internal/importers/claudecode"
	"github.com/c3-oss/prosa/internal/importers/codex"
	"github.com/c3-oss/prosa/internal/importers/cursor"
	"github.com/c3-oss/prosa/internal/importers/gemini"
	"github.com/c3-oss/prosa/internal/importers/hermes"
	"github.com/c3-oss/prosa/pkg/importer"
)

func registeredImporters() []importer.Importer {
	return []importer.Importer{
		claudecode.New(),
		codex.New(),
		cursor.New(),
		gemini.New(),
		antigravity.New(),
		hermes.New(),
	}
}

func registeredAgentNames() []string {
	imps := registeredImporters()
	names := make([]string, 0, len(imps))
	for _, imp := range imps {
		names = append(names, imp.Name())
	}
	return names
}

func registeredAgentHelp() string {
	return strings.Join(registeredAgentNames(), " | ")
}

func validateAgentName(agent string) error {
	if agent == "" {
		return nil
	}
	names := registeredAgentNames()
	for _, name := range names {
		if agent == name {
			return nil
		}
	}
	return fmt.Errorf("--agent: unknown agent %q; expected one of (%s)", agent, strings.Join(names, ", "))
}
