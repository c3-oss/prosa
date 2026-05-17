/**
 * Producer-consumer pipeline for read-then-upload workflows.
 *
 * A fixed pool of readers fills a bounded in-memory queue; a separate pool of
 * uploaders drains it. When reads outpace uploads the queue fills and readers
 * block. When uploads outpace reads uploaders wait on the queue. This keeps
 * upload slots busy during disk I/O and decouples read latency from upload
 * latency.
 */

export interface PipelineOptions<TItem, TLoaded> {
  /** Items to process. Consumed in order by read workers. */
  items: ReadonlyArray<TItem>
  /** Number of concurrent read workers. */
  readConcurrency: number
  /** Number of concurrent upload/consume workers. */
  uploadConcurrency: number
  /**
   * Maximum number of loaded items that can sit in the queue at one time.
   * Keeps peak memory bounded.
   */
  queueBound: number
  /**
   * Optional maximum number of queued loaded bytes. An item larger than this
   * limit is still allowed through an empty queue so the pipeline cannot wedge.
   */
  maxBufferedBytes?: number
  /** Returns the memory size of a loaded item when `maxBufferedBytes` is set. */
  loadedByteLength?: (loaded: TLoaded) => number
  /** Load an item from a slow source (e.g. disk). Called by read workers. */
  load: (item: TItem) => Promise<TLoaded>
  /** Upload or otherwise consume a loaded item. Called by upload workers. */
  consume: (loaded: TLoaded) => Promise<void>
  /**
   * Optional hook called after consume returns (or is skipped due to abort).
   * Use to release large buffers promptly.
   */
  releaseLoaded?: (loaded: TLoaded) => void
}

/**
 * Runs a producer-consumer pipeline over `opts.items`.
 *
 * All errors are collected and re-raised as an `AggregateError` after both
 * pools have settled. If any worker fails the internal AbortController signals
 * all other workers so they drain and exit quickly.
 */
export async function runReadUploadPipeline<TItem, TLoaded>(opts: PipelineOptions<TItem, TLoaded>): Promise<void> {
  if (opts.items.length === 0) return
  if (opts.readConcurrency < 1) throw new Error('readConcurrency must be at least 1')
  if (opts.uploadConcurrency < 1) throw new Error('uploadConcurrency must be at least 1')
  if (opts.queueBound < 1) throw new Error('queueBound must be at least 1')
  if (opts.maxBufferedBytes !== undefined && opts.maxBufferedBytes < 1) {
    throw new Error('maxBufferedBytes must be at least 1 when set')
  }

  const controller = new AbortController()
  const { signal } = controller

  // -- Queue state ---------------------------------------------------------

  type QueueEntry = {
    loaded: TLoaded
    bytes: number
  }
  type EnqueueWaiter = {
    entry: QueueEntry
    resolve: (accepted: boolean) => void
  }

  /** Loaded items waiting to be consumed. */
  const queue: QueueEntry[] = []
  let queuedBytes = 0
  /** Resolvers waiting to dequeue an item (upload workers blocked on empty). */
  const dequeueWaiters: Array<(loaded: TLoaded | null) => void> = []
  /** Resolvers waiting to enqueue an item (read workers blocked on full). */
  const enqueueWaiters: EnqueueWaiter[] = []

  let producersDone = 0
  const totalProducers = Math.min(opts.readConcurrency, opts.items.length)
  const errors: unknown[] = []

  // -- Queue operations ----------------------------------------------------

  function loadedByteLength(loaded: TLoaded): number {
    if (opts.maxBufferedBytes === undefined) return 0
    const bytes = opts.loadedByteLength?.(loaded) ?? 0
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new Error('loadedByteLength must return a non-negative finite number')
    }
    return bytes
  }

  function releaseLoaded(loaded: TLoaded): void {
    try {
      opts.releaseLoaded?.(loaded)
    } catch (err) {
      errors.push(err)
      abortPipeline()
    }
  }

  function drainQueueForAbort(): void {
    while (queue.length > 0) {
      const entry = queue.shift() as QueueEntry
      queuedBytes -= entry.bytes
      releaseLoaded(entry.loaded)
    }
  }

  function resolveAllEnqueueWaiters(accepted: boolean): void {
    while (enqueueWaiters.length > 0) {
      const waiter = enqueueWaiters.shift() as EnqueueWaiter
      waiter.resolve(accepted)
    }
  }

  function resolveAllDequeueWaiters(loaded: TLoaded | null): void {
    while (dequeueWaiters.length > 0) {
      const resolve = dequeueWaiters.shift() as (loaded: TLoaded | null) => void
      resolve(loaded)
    }
  }

  function canAccept(entry: QueueEntry): boolean {
    if (queue.length >= opts.queueBound) return false
    if (opts.maxBufferedBytes === undefined) return true
    if (queuedBytes + entry.bytes <= opts.maxBufferedBytes) return true
    // Allow a single oversized item through an empty queue to avoid deadlock.
    return queue.length === 0
  }

  function pumpQueue(): void {
    if (signal.aborted) {
      drainQueueForAbort()
      resolveAllEnqueueWaiters(false)
      resolveAllDequeueWaiters(null)
      return
    }

    while (true) {
      let progressed = false

      while (enqueueWaiters.length > 0 && canAccept(enqueueWaiters[0]!.entry)) {
        const waiter = enqueueWaiters.shift() as EnqueueWaiter
        queue.push(waiter.entry)
        queuedBytes += waiter.entry.bytes
        if (dequeueWaiters.length > 0) {
          const entry = queue.shift() as QueueEntry
          queuedBytes -= entry.bytes
          const resolve = dequeueWaiters.shift() as (loaded: TLoaded | null) => void
          resolve(entry.loaded)
        }
        waiter.resolve(true)
        progressed = true
      }

      while (dequeueWaiters.length > 0 && queue.length > 0) {
        const entry = queue.shift() as QueueEntry
        queuedBytes -= entry.bytes
        const resolve = dequeueWaiters.shift() as (loaded: TLoaded | null) => void
        resolve(entry.loaded)
        progressed = true
      }

      if (!progressed) break
    }

    if (producersDone === totalProducers && queue.length === 0) {
      resolveAllDequeueWaiters(null)
    }
  }

  function abortPipeline(): void {
    if (!signal.aborted) controller.abort()
    pumpQueue()
  }

  function enqueue(loaded: TLoaded): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    const entry = { loaded, bytes: loadedByteLength(loaded) }
    return new Promise<boolean>((resolve) => {
      enqueueWaiters.push({ entry, resolve })
      pumpQueue()
    })
  }

  function dequeue(): Promise<TLoaded | null> {
    if (signal.aborted) return Promise.resolve(null)
    return new Promise<TLoaded | null>((resolve) => {
      dequeueWaiters.push(resolve)
      pumpQueue()
    })
  }

  // -- Workers -------------------------------------------------------------

  // Shared work list: read workers pull from this atomically.
  let nextItemIndex = 0

  async function readWorker(): Promise<void> {
    try {
      while (!signal.aborted) {
        const index = nextItemIndex
        nextItemIndex += 1
        if (index >= opts.items.length) break
        const item = opts.items[index] as TItem
        const loaded = await opts.load(item)
        let accepted = false
        try {
          accepted = !signal.aborted && (await enqueue(loaded))
        } finally {
          if (!accepted) releaseLoaded(loaded)
        }
        if (!accepted) break
      }
    } catch (err) {
      errors.push(err)
      abortPipeline()
    } finally {
      producersDone += 1
      pumpQueue()
    }
  }

  async function uploadWorker(): Promise<void> {
    try {
      while (true) {
        const loaded = await dequeue()
        if (loaded === null) break
        try {
          if (!signal.aborted) await opts.consume(loaded)
        } finally {
          releaseLoaded(loaded)
        }
      }
    } catch (err) {
      errors.push(err)
      abortPipeline()
    }
  }

  const reads = Array.from({ length: totalProducers }, () => readWorker())
  const uploads = Array.from({ length: Math.min(opts.uploadConcurrency, opts.items.length) }, () => uploadWorker())

  await Promise.allSettled([...reads, ...uploads])

  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, `Pipeline failed with ${errors.length} errors`)
}
