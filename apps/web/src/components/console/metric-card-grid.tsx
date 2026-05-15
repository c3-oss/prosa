import { formatCount } from '~/lib/format.js'

export type MetricCardGridProps = {
  summary: {
    counts: { sessions: number; objects: number; docs: number; sources: number }
    sources: Array<{ sourceKind: string; count: number }>
  } | null
  isLoading?: boolean
}

const metricLabels: Array<{ key: 'sessions' | 'docs' | 'sources' | 'objects'; label: string }> = [
  { key: 'sessions', label: 'Sessions' },
  { key: 'docs', label: 'Search docs' },
  { key: 'sources', label: 'Sources' },
  { key: 'objects', label: 'Objects' },
]

export function MetricCardGrid({ summary, isLoading }: MetricCardGridProps) {
  return (
    <ul className="console-metric-grid" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {metricLabels.map((metric) => (
        <li key={metric.key} className="console-card">
          <span className="console-card-label">{metric.label}</span>
          <span className="console-card-value">{isLoading ? '…' : formatCount(summary?.counts[metric.key] ?? 0)}</span>
        </li>
      ))}
    </ul>
  )
}
