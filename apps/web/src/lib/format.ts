export function formatRelativeTime(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return 'unknown'
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return 'unknown'
  const diffMs = parsed - now.getTime()
  const absSeconds = Math.abs(diffMs) / 1000
  const sign = diffMs < 0 ? -1 : 1
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (absSeconds < 60) return formatter.format(Math.round(sign * absSeconds), 'second')
  if (absSeconds < 3600) return formatter.format(Math.round(sign * (absSeconds / 60)), 'minute')
  if (absSeconds < 86400) return formatter.format(Math.round(sign * (absSeconds / 3600)), 'hour')
  return formatter.format(Math.round(sign * (absSeconds / 86400)), 'day')
}

export function formatAbsoluteTime(value: string | null | undefined): string {
  if (!value) return 'unknown'
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return 'unknown'
  return `${new Date(parsed).toISOString().replace('T', ' ').slice(0, 19)}Z`
}

export function formatCount(value: number | null | undefined): string {
  if (value == null) return '—'
  if (value < 1000) return value.toString()
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1)}…`
}
