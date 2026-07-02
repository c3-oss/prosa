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
	slots, _ := ResolveSlots(items, TimelineGlobal)
	require.False(t, slots.Device, "1 distinct device → omit device")
	require.False(t, slots.Project, "1 distinct project → omit project")
}

func TestResolveSlotsSingleDeviceManyProjects(t *testing.T) {
	items := []TimelineItem{
		mkItem("d1", "/u/foo"),
		mkItem("d1", "/u/bar"),
	}
	slots, _ := ResolveSlots(items, TimelineGlobal)
	require.False(t, slots.Device)
	require.True(t, slots.Project)
}

func TestResolveSlotsManyDevicesSingleProject(t *testing.T) {
	items := []TimelineItem{
		mkItem("d1", "/u/foo"),
		mkItem("d2", "/u/foo"),
	}
	slots, _ := ResolveSlots(items, TimelineGlobal)
	require.True(t, slots.Device)
	require.False(t, slots.Project)
}

func TestResolveSlotsManyEverything(t *testing.T) {
	items := []TimelineItem{
		mkItem("d1", "/u/foo"),
		mkItem("d2", "/u/bar"),
	}
	slots, _ := ResolveSlots(items, TimelineGlobal)
	require.True(t, slots.Device)
	require.True(t, slots.Project)
}

func TestResolveSlotsScopedAlwaysDropsProject(t *testing.T) {
	items := []TimelineItem{
		mkItem("d1", "/u/foo"),
		mkItem("d2", "/u/bar"), // even with cardinality > 1
	}
	slots, _ := ResolveSlots(items, TimelineScoped)
	require.True(t, slots.Device)
	require.False(t, slots.Project, "scoped layout always drops project")
}

func mkRemoteItem(deviceID, remote string) TimelineItem {
	r := remote
	return TimelineItem{Session: session.Session{
		DeviceID:       deviceID,
		ProjectRemote:  &r,
		Agent:          "codex",
		StartedAt:      time.Now(),
		LastActivityAt: time.Now(),
	}}
}

func TestResolveSlotsReportsUniformValues(t *testing.T) {
	items := []TimelineItem{
		mkRemoteItem("dev-1", "git@github.com:c3-oss/prosa.git"),
		mkRemoteItem("dev-1", "git@github.com:c3-oss/prosa.git"),
	}
	slots, uniform := ResolveSlots(items, TimelineGlobal)
	require.False(t, slots.Device)
	require.False(t, slots.Project)
	require.Equal(t, "dev-1", uniform.DeviceID)
	require.Equal(t, "c3-oss/prosa", uniform.Project)
}

func TestResolveSlotsUniformEmptyWhenColumnsVary(t *testing.T) {
	items := []TimelineItem{
		mkRemoteItem("dev-1", "git@github.com:c3-oss/prosa.git"),
		mkRemoteItem("dev-2", "git@github.com:c3-oss/q.git"),
	}
	_, uniform := ResolveSlots(items, TimelineGlobal)
	require.Empty(t, uniform.DeviceID)
	require.Empty(t, uniform.Project)
}

func TestResolveSlotsUniformSkipsUnscopedLabel(t *testing.T) {
	items := []TimelineItem{
		{Session: session.Session{DeviceID: "dev-1"}},
		{Session: session.Session{DeviceID: "dev-1"}},
	}
	_, uniform := ResolveSlots(items, TimelineGlobal)
	require.Equal(t, "dev-1", uniform.DeviceID)
	require.Empty(t, uniform.Project, "(unscoped) must not surface as a uniform project")
}
