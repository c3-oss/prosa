// Lane 8 — CQ-156 cadence-aware scheduler.
//
// The production scheduler wakes up every `tickMs` and only fires
// each registered handler when its per-cadence interval has elapsed.
// This pin proves the hourly/daily/weekly/monthly mapping, so a
// fast-firing wake-up tick can't over-run the weekly/monthly handlers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cadenceForExpression, intervalScheduler } from '../../../src/cron/wire.js'

describe('Lane 8 cadenceForExpression — CQ-156', () => {
  it('maps every CRON_TASK_DEFINITIONS expression to its spec cadence', () => {
    expect(cadenceForExpression('0 * * * *')).toBe(60 * 60 * 1000)
    expect(cadenceForExpression('0 1 * * *')).toBe(24 * 60 * 60 * 1000)
    expect(cadenceForExpression('0 2 * * *')).toBe(24 * 60 * 60 * 1000)
    expect(cadenceForExpression('0 3 * * 0')).toBe(7 * 24 * 60 * 60 * 1000)
    expect(cadenceForExpression('0 4 1 * *')).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('falls back to one minute for unknown expressions', () => {
    expect(cadenceForExpression('*/5 * * * *')).toBe(60 * 1000)
  })
})

describe('Lane 8 intervalScheduler — CQ-156', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('runs a daily handler at most once per 24h wake-up cycle', async () => {
    const scheduler = intervalScheduler(60_000) // 1m wake-up tick
    let calls = 0
    scheduler('0 2 * * *', async () => {
      calls += 1
    })

    // First wake-up: handler fires (lastFiredMs starts at 0, cadence
    // is 24h, the first tick is past the cadence so it fires).
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(1)

    // Subsequent wake-ups within the 24h window do NOT re-fire.
    await vi.advanceTimersByTimeAsync(60_000 * 60) // +60 minutes
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000 * 60 * 12) // +12 hours
    expect(calls).toBe(1)

    // After ~24h has elapsed since the last fire, the handler runs
    // once more.
    await vi.advanceTimersByTimeAsync(60_000 * 60 * 12) // total +24h+1m
    expect(calls).toBe(2)
  })

  it('runs an hourly handler about once per hour, not per minute', async () => {
    const scheduler = intervalScheduler(60_000) // 1m wake-up tick
    let calls = 0
    scheduler('0 * * * *', async () => {
      calls += 1
    })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(1)
    // 30 minutes of wake-ups: no extra fires.
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(1)
    // Cross the 60-minute boundary: fires once.
    for (let i = 0; i < 31; i++) await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(2)
  })
})
