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

  const controller = new AbortController()
  const { signal } = controller

  // -- Queue state ---------------------------------------------------------

  /** Loaded items waiting to be consumed. */
  const queue: TLoaded[] = []
  /** Resolvers waiting to dequeue an item (upload workers blocked on empty). */
  const dequeueWaiters: Array<() => void> = []
  /** Resolvers waiting to enqueue an item (read workers blocked on full). */
  const enqueueWaiters: Array<() => void> = []

  let producersDone = 0
  const totalProducers = Math.min(opts.readConcurrency, opts.items.length)

  // -- Queue operations ----------------------------------------------------

  function notifyDequeueWaiter(): void {
    dequeueWaiters.shift()?.()
  }

  function notifyAllDequeueWaiters(): void {
    while (dequeueWaiters.length > 0) dequeueWaiters.shift()?.()
  }

  function tryEnqueue(item: TLoaded, resolve: () => void): void {
    if (queue.length < opts.queueBound) {
      queue.push(item)
      notifyDequeueWaiter()
      resolve()
    } else {
      // Queue is full: retry when a slot opens.
      enqueueWaiters.push(() => tryEnqueue(item, resolve))
    }
  }

  function enqueue(item: TLoaded): Promise<void> {
    return new Promise<void>((resolve) => tryEnqueue(item, resolve))
  }

  function dequeue(): Promise<TLoaded | null> {
    const tryDequeue = (resolve: (v: TLoaded | null) => void): void => {
      if (queue.length > 0) {
        const item = queue.shift() as TLoaded
        // Wake a blocked reader that was waiting for a queue slot.
        enqueueWaiters.shift()?.()
        resolve(item)
      } else if (producersDone === totalProducers) {
        resolve(null)
      } else {
        dequeueWaiters.push(() => tryDequeue(resolve))
      }
    }
    return new Promise<TLoaded | null>((resolve) => tryDequeue(resolve))
  }

  // -- Workers -------------------------------------------------------------

  // Shared work list: read workers pull from this atomically.
  let nextItemIndex = 0
  const errors: unknown[] = []

  async function readWorker(): Promise<void> {
    try {
      while (!signal.aborted) {
        const index = nextItemIndex
        nextItemIndex += 1
        if (index >= opts.items.length) break
        const item = opts.items[index] as TItem
        const loaded = await opts.load(item)
        if (signal.aborted) {
          opts.releaseLoaded?.(loaded)
          break
        }
        await enqueue(loaded)
      }
    } catch (err) {
      errors.push(err)
      controller.abort()
    } finally {
      producersDone += 1
      if (producersDone === totalProducers) {
        // All readers done: wake any blocked upload workers.
        notifyAllDequeueWaiters()
      }
    }
  }

  async function uploadWorker(): Promise<void> {
    try {
      while (true) {
        const loaded = await dequeue()
        if (loaded === null) break
        if (signal.aborted) {
          opts.releaseLoaded?.(loaded)
          continue
        }
        await opts.consume(loaded)
        opts.releaseLoaded?.(loaded)
      }
    } catch (err) {
      errors.push(err)
      controller.abort()
      // Drain leftover queue entries so blocked readers can unblock and exit.
      notifyAllDequeueWaiters()
    }
  }

  const reads = Array.from({ length: totalProducers }, () => readWorker())
  const uploads = Array.from({ length: Math.min(opts.uploadConcurrency, opts.items.length) }, () => uploadWorker())

  await Promise.allSettled([...reads, ...uploads])

  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, `Pipeline failed with ${errors.length} errors`)
}
