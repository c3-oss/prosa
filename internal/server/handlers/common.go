package handlers

import (
	"errors"
	"strings"
)

// missingFields returns a small InvalidArgument error listing fields the
// caller failed to populate. Used by every handler that does input
// shape checks.
func missingFields(fields ...string) error {
	return errors.New("missing required fields: " + strings.Join(fields, ", "))
}
