export async function mapConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index] as T
      await worker(item, index)
    }
  })
  await Promise.all(workers)
}

export async function mapConcurrentResults<T, TResult>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length)
  await mapConcurrent(items, concurrency, async (item, index) => {
    results[index] = await worker(item, index)
  })
  return results
}
