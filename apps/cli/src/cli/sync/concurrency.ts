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
      const item = items[index]
      if (!item) return
      await worker(item, index)
    }
  })
  await Promise.all(workers)
}
