import { z } from 'zod'

export const DASHBOARD_LAYOUT_KEY = 'dashboard.layout.v1'
export const DASHBOARD_COLUMNS = 12

export const widgetIdSchema = z.enum(['activity', 'daily-threads', 'tokens-by-agent', 'agent-vs-subagent'])
export type WidgetId = z.infer<typeof widgetIdSchema>

export const widgetItemSchema = z.object({
  id: widgetIdSchema,
  w: z.number().int().min(2).max(DASHBOARD_COLUMNS),
  h: z.number().int().min(1).max(3),
})
export type WidgetItem = z.infer<typeof widgetItemSchema>

export const dashboardLayoutSchema = z.object({
  version: z.literal(1),
  items: z.array(widgetItemSchema),
})
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>

export const DEFAULT_LAYOUT: DashboardLayout = {
  version: 1,
  items: [
    { id: 'activity', w: 12, h: 1 },
    { id: 'daily-threads', w: 6, h: 1 },
    { id: 'tokens-by-agent', w: 6, h: 1 },
    { id: 'agent-vs-subagent', w: 12, h: 1 },
  ],
}

export const WIDGET_TITLES: Record<WidgetId, string> = {
  activity: 'Activity',
  'daily-threads': 'Daily threads',
  'tokens-by-agent': 'Tokens by agent',
  'agent-vs-subagent': 'Agents vs subagents',
}

export function parseLayout(input: unknown): DashboardLayout {
  const parsed = dashboardLayoutSchema.safeParse(input)
  if (!parsed.success) return DEFAULT_LAYOUT
  const known = new Set(parsed.data.items.map((item) => item.id))
  const missing = DEFAULT_LAYOUT.items.filter((item) => !known.has(item.id))
  if (missing.length === 0) return parsed.data
  return { ...parsed.data, items: [...parsed.data.items, ...missing] }
}
