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

// ResolveSlots inspects items + layout intent and returns the slot
// flags. Rules:
//
//   - TimelineScoped implies omit-project regardless of cardinality
//     (the context line already names the project).
//   - 1 distinct device id → omit device.
//   - 1 distinct project label → omit project.
//
// Agent is never a slot — it's central enough that we always render
// it, even when uniform.
func ResolveSlots(items []TimelineItem, layout TimelineLayout) RowSlots {
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
	return slots
}
