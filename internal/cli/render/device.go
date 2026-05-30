package render

// DeviceLabel translates a device fingerprint into the human label
// used in the timeline / search rows. When the caller has a populated
// map (id → friendly_name), the mapped value wins. Otherwise we fall
// back to the first 7 hex chars + "…", which at least signals the
// shape of the id while staying narrow enough for the row layout.
//
// The fallback should never be hit in practice — `prosa sync`
// upserts a device row before any session writes — but we keep it
// defensive for sessions loaded from external stores.
func DeviceLabel(m map[string]string, id string) string {
	if name, ok := m[id]; ok && name != "" {
		return name
	}
	if len(id) <= 7 {
		return id
	}
	return id[:7] + "…"
}
