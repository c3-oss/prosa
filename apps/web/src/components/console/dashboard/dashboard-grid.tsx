import { DndContext, type DragEndEvent, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy } from '@dnd-kit/sortable'
import type { ComponentType } from 'react'

import { WIDGET_TITLES, type WidgetId, type WidgetItem } from './layout.js'
import { useDashboardLayout } from './use-dashboard-layout.js'
import { WidgetFrame } from './widget-frame.js'
import { ActivityWidget } from './widgets/activity-widget.js'
import { AgentVsSubagentWidget } from './widgets/agent-vs-subagent-widget.js'
import { DailyThreadsWidget } from './widgets/daily-threads-widget.js'
import { TokensByAgentWidget } from './widgets/tokens-by-agent-widget.js'

type WidgetProps = { tenantId: string }

const WIDGET_RENDERERS: Record<WidgetId, ComponentType<WidgetProps>> = {
  activity: ActivityWidget,
  'daily-threads': DailyThreadsWidget,
  'tokens-by-agent': TokensByAgentWidget,
  'agent-vs-subagent': AgentVsSubagentWidget,
}

export type DashboardGridProps = {
  tenantId: string
}

export function DashboardGrid({ tenantId }: DashboardGridProps) {
  const { layout, setLayout, reset, isSaving } = useDashboardLayout()
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Small activation distance so clicks inside widgets (window-toggles,
      // legend buttons) do not trigger a drag.
      activationConstraint: { distance: 5 },
    }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = layout.items.findIndex((item) => item.id === active.id)
    const newIndex = layout.items.findIndex((item) => item.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    setLayout({ ...layout, items: arrayMove(layout.items, oldIndex, newIndex) })
  }

  const handleResize = (id: WidgetId) => (next: { w: number; h: number }) => {
    setLayout({
      ...layout,
      items: layout.items.map((item) => (item.id === id ? { ...item, w: next.w, h: next.h } : item)),
    })
  }

  return (
    <>
      <div className="dashboard-toolbar">
        <span className="dashboard-toolbar-info">
          Drag a widget header to rearrange. Use the bottom-right corner to resize.
          {isSaving ? ' Saving…' : null}
        </span>
        <button type="button" className="dashboard-toolbar-button" onClick={reset}>
          Reset layout
        </button>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={layout.items.map((item) => item.id)} strategy={rectSortingStrategy}>
          <section className="dashboard-grid" aria-label="Customizable dashboard widgets">
            {layout.items.map((item: WidgetItem) => {
              const Widget = WIDGET_RENDERERS[item.id]
              return (
                <WidgetFrame key={item.id} item={item} title={WIDGET_TITLES[item.id]} onResize={handleResize(item.id)}>
                  <Widget tenantId={tenantId} />
                </WidgetFrame>
              )
            })}
          </section>
        </SortableContext>
      </DndContext>
    </>
  )
}
