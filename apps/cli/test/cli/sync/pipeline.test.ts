import { describe, expect, it } from 'vitest'
import { runReadUploadPipeline } from '../../../src/cli/sync/pipeline.js'

describe('runReadUploadPipeline', () => {
  it('processes all items when read > upload concurrency', async () => {
    const loaded: number[] = []
    const consumed: number[] = []

    await runReadUploadPipeline<number, number>({
      items: Array.from({ length: 10 }, (_, i) => i),
      readConcurrency: 4,
      uploadConcurrency: 2,
      queueBound: 8,
      load: async (item) => {
        loaded.push(item)
        return item
      },
      consume: async (item) => {
        consumed.push(item)
      },
    })

    expect(loaded).toHaveLength(10)
    expect(consumed).toHaveLength(10)
    // Every item must have been consumed exactly once.
    expect(consumed.slice().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('processes all items when upload > read concurrency', async () => {
    const consumed: number[] = []

    await runReadUploadPipeline<number, number>({
      items: Array.from({ length: 10 }, (_, i) => i),
      readConcurrency: 2,
      uploadConcurrency: 4,
      queueBound: 8,
      load: async (item) => item,
      consume: async (item) => {
        consumed.push(item)
      },
    })

    expect(consumed).toHaveLength(10)
    expect(consumed.slice().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('returns immediately for an empty items array', async () => {
    let loadCalled = false
    await runReadUploadPipeline({
      items: [],
      readConcurrency: 4,
      uploadConcurrency: 2,
      queueBound: 8,
      load: async () => {
        loadCalled = true
        return 0
      },
      consume: async () => {},
    })
    expect(loadCalled).toBe(false)
  })

  it('releases loaded items via releaseLoaded hook', async () => {
    const released: number[] = []

    await runReadUploadPipeline<number, number>({
      items: [1, 2, 3],
      readConcurrency: 2,
      uploadConcurrency: 2,
      queueBound: 8,
      load: async (item) => item,
      consume: async () => {},
      releaseLoaded: (item) => released.push(item),
    })

    expect(released).toHaveLength(3)
    expect(released.slice().sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('rejects when a read worker throws and stops remaining work', async () => {
    const consumed: number[] = []
    const failOn = 3

    await expect(
      runReadUploadPipeline<number, number>({
        items: Array.from({ length: 10 }, (_, i) => i),
        readConcurrency: 2,
        uploadConcurrency: 2,
        queueBound: 4,
        load: async (item) => {
          if (item === failOn) throw new Error(`read failed on item ${item}`)
          return item
        },
        consume: async (item) => {
          consumed.push(item)
        },
      }),
    ).rejects.toThrow(`read failed on item ${failOn}`)

    // Upload must have stopped; not all items should have been consumed.
    expect(consumed.length).toBeLessThan(10)
  })

  it('rejects when an upload worker throws', async () => {
    const loaded: number[] = []
    const failOn = 2

    await expect(
      runReadUploadPipeline<number, number>({
        items: Array.from({ length: 10 }, (_, i) => i),
        readConcurrency: 2,
        uploadConcurrency: 2,
        queueBound: 4,
        load: async (item) => {
          loaded.push(item)
          return item
        },
        consume: async (item) => {
          if (item === failOn) throw new Error(`upload failed on item ${item}`)
        },
      }),
    ).rejects.toThrow(`upload failed on item ${failOn}`)
  })

  it('works correctly with a queue bound of 1 (maximum backpressure)', async () => {
    const consumed: number[] = []

    await runReadUploadPipeline<number, number>({
      items: Array.from({ length: 5 }, (_, i) => i),
      readConcurrency: 2,
      uploadConcurrency: 2,
      queueBound: 1,
      load: async (item) => item,
      consume: async (item) => {
        consumed.push(item)
      },
    })

    expect(consumed).toHaveLength(5)
    expect(consumed.slice().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
  })

  it('works with a single read worker and single upload worker', async () => {
    const order: string[] = []

    await runReadUploadPipeline<number, number>({
      items: [10, 20, 30],
      readConcurrency: 1,
      uploadConcurrency: 1,
      queueBound: 8,
      load: async (item) => {
        order.push(`read:${item}`)
        return item
      },
      consume: async (item) => {
        order.push(`consume:${item}`)
      },
    })

    // With concurrency 1 on each side the order must be strictly sequential.
    expect(order).toEqual(['read:10', 'consume:10', 'read:20', 'consume:20', 'read:30', 'consume:30'])
  })

  it('accumulates totals correctly via closure (simulates metrics)', async () => {
    let totalBytes = 0
    let totalObjects = 0

    const items = Array.from({ length: 10 }, (_, i) => ({ id: i, size: (i + 1) * 100 }))

    await runReadUploadPipeline({
      items,
      readConcurrency: 4,
      uploadConcurrency: 2,
      queueBound: 8,
      load: async (item) => ({ ...item, data: new Uint8Array(item.size) }),
      consume: async (loaded) => {
        totalBytes += loaded.data.byteLength
        totalObjects += 1
      },
    })

    const expectedBytes = items.reduce((sum, item) => sum + item.size, 0)
    expect(totalObjects).toBe(10)
    expect(totalBytes).toBe(expectedBytes)
  })
})
