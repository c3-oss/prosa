// Optional perf-mark observer. Enable with `node --import bench/perf/tools/perf-marks.mjs ...`
// Emits NDJSON lines to stderr: {ts, name, durationMs}
// Zero overhead when PROFILE_MARKS != '1'.
import { PerformanceObserver, performance } from 'node:perf_hooks'

if (process.env.PROFILE_MARKS === '1') {
  const obs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType === 'measure' || entry.entryType === 'gc') {
        process.stderr.write(
          `${JSON.stringify({
            ts: Date.now(),
            type: entry.entryType,
            name: entry.name,
            durationMs: Number(entry.duration.toFixed(3)),
            ...(entry.entryType === 'gc' && entry.detail ? { kind: entry.detail.kind } : {}),
          })}\n`,
        )
      }
    }
  })
  obs.observe({ entryTypes: ['measure', 'gc'] })

  // Sample eventLoopUtilization every 1s.
  let lastELU = performance.eventLoopUtilization()
  setInterval(() => {
    const now = performance.eventLoopUtilization(lastELU)
    process.stderr.write(
      `${JSON.stringify({ ts: Date.now(), type: 'elu', utilization: Number(now.utilization.toFixed(4)) })}\n`,
    )
    lastELU = performance.eventLoopUtilization()
  }, 1000).unref()
}
