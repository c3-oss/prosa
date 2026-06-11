package handlers

import (
	"errors"
	"strings"
)

// missingFields returns an error listing required fields the caller omitted.
func missingFields(fields ...string) error {
	return errors.New("missing required fields: " + strings.Join(fields, ", "))
}
