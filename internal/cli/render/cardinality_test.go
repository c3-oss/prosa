package render

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func mkItem(deviceID, project string) TimelineItem {
	p := project
	return TimelineItem{Session: session.Session{
		DeviceID:       deviceID,
		ProjectPath:    &p,
		Agent:          "codex",
		StartedAt:      time.Now(),
		LastActivityAt: time.Now(),
	}}
}

func TestResolveSlotsSingleDeviceSingleProject(t *testing.T) {
	items := []TimelineItem{
		mkItem("d1", "/u/foo"),
		mkItem("d1", "/u/foo"),
	}
	slots := ResolveSlots(items, TimelineGlobal)
	require.False(t, slots.Device, "1 distinct device → omit device")
	require.False(t, slots.Project, "1 distinct project → omit project")
}

func TestResolveSlotsSingleDeviceManyProjects(t *testing.T) {
	items := []TimelineItem{
		mkItem("d1", "/u/foo"),
		mkItem("d1", "/u/bar"),
	}
	slots := ResolveSlots(items, TimelineGlobal)
	require.False(t, slots.Device)
	require.True(t, slots.Project)
}

func TestResolveSlotsManyDevicesSingleProject(t *testing.T) {
	items := []TimelineItem{
		mkItem("d1", "/u/foo"),
		mkItem("d2", "/u/foo"),
	}
	slots := ResolveSlots(items, TimelineGlobal)
	require.True(t, slots.Device)
	require.False(t, slots.Project)
}

func TestResolveSlotsManyEverything(t *testing.T) {
	items := []TimelineItem{
		mkItem("d1", "/u/foo"),
		mkItem("d2", "/u/bar"),
	}
	slots := ResolveSlots(items, TimelineGlobal)
	require.True(t, slots.Device)
	require.True(t, slots.Project)
}

func TestResolveSlotsScopedAlwaysDropsProject(t *testing.T) {
	items := []TimelineItem{
		mkItem("d1", "/u/foo"),
		mkItem("d2", "/u/bar"), // even with cardinality > 1
	}
	slots := ResolveSlots(items, TimelineScoped)
	require.True(t, slots.Device)
	require.False(t, slots.Project, "scoped layout always drops project")
}
