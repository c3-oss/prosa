package render

// RowSlots decides which optional columns the timeline (or search hit)
// renders. A slot set to false collapses the column entirely so the
// remaining ones absorb the freed width. This is the cardinality-1
// rule: when every row in the set shares the same value for a
// column, render that column once in the context line and drop it
// from the rows.
type RowSlots struct {
	Device  bool
	Project bool
}

// UniformValues carries the value shared by every row when a column
// collapses to cardinality 1, so the caller can surface it in the
// context line instead of dropping the information entirely.
type UniformValues struct {
	DeviceID string // single device id, when only one distinct device
	Project  string // single project label, when only one distinct project
}

// ResolveSlots inspects items + layout intent and returns the slot
// flags plus the uniform values behind any suppressed column. Rules:
//
//   - TimelineScoped implies omit-project regardless of cardinality
//     (the context line already names the project).
//   - 1 distinct device id → omit device.
//   - 1 distinct project label → omit project.
//
// Agent is never a slot — it's central enough that we always render
// it, even when uniform.
func ResolveSlots(items []TimelineItem, layout TimelineLayout) (RowSlots, UniformValues) {
	devices := map[string]struct{}{}
	projects := map[string]struct{}{}
	for _, it := range items {
		devices[it.Session.DeviceID] = struct{}{}
		projects[projectLabel(it.Session)] = struct{}{}
	}
	slots := RowSlots{
		Device:  len(devices) > 1,
		Project: len(projects) > 1,
	}
	if layout == TimelineScoped {
		slots.Project = false
	}
	uniform := UniformValues{}
	if len(items) > 0 {
		if len(devices) == 1 {
			uniform.DeviceID = items[0].Session.DeviceID
		}
		if label := projectLabel(items[0].Session); len(projects) == 1 && label != unscopedProjectLabel {
			uniform.Project = label
		}
	}
	return slots, uniform
}
