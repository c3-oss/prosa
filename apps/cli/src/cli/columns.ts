/**
 * Per-command column control. Each command exposes a `ColumnSet`:
 *
 *   - `default`: the columns shown in `table`/`interactive` output when no
 *     `--columns` flag is given. Chosen to fit a ~120-char terminal.
 *   - `all`: the full superset, used for `--columns all` and as the validation
 *     vocabulary for explicit `--columns col1,col2` lists.
 *   - `maxWidths` (optional): per-column hard caps passed to `printRows`
 *     `maxColumnWidths`.
 *   - `tail` (optional): set of column names rendered with a leading `…` so
 *     the tail of long values (paths) stays visible after truncation.
 */
export interface ColumnSet<T extends string> {
  default: readonly T[]
  all: readonly T[]
  maxWidths?: Readonly<Partial<Record<T, number>>>
  tail?: ReadonlySet<T>
}

/**
 * Resolve the `--columns` flag against a ColumnSet. Accepts:
 *
 *   - `undefined` → `set.default`
 *   - `'default'` → `set.default`
 *   - `'all'`     → `set.all`
 *   - CSV like `'a,b,c'` → the listed columns, validated against `set.all`
 *
 * Throws on unknown column names so typos surface immediately.
 */
export function resolveColumns<T extends string>(set: ColumnSet<T>, requested: string | undefined): readonly T[] {
  if (requested === undefined) return set.default
  const trimmed = requested.trim()
  if (trimmed === '' || trimmed === 'default') return set.default
  if (trimmed === 'all') return set.all

  const allowed = new Set<string>(set.all)
  const picks: T[] = []
  for (const raw of trimmed.split(',')) {
    const name = raw.trim()
    if (name.length === 0) continue
    if (!allowed.has(name)) {
      throw new Error(`unknown column: ${name} (available: ${set.all.join(', ')})`)
    }
    picks.push(name as T)
  }
  if (picks.length === 0) return set.default
  return picks
}

/**
 * Build the `maxColumnWidths` map for `printRows` from a `ColumnSet`, filtered
 * to the subset of columns actually being rendered. Returns `undefined` when
 * no caps apply, so callers can pass it through to `printRows` directly.
 */
export function maxWidthsForColumns<T extends string>(
  set: ColumnSet<T>,
  columns: readonly T[],
): Record<string, number> | undefined {
  if (!set.maxWidths) return undefined
  const result: Record<string, number> = {}
  for (const col of columns) {
    const cap = set.maxWidths[col]
    if (cap !== undefined) result[col] = cap
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/**
 * Build the `tailColumns` set for `printRows` from a `ColumnSet`, filtered to
 * the subset actually rendered. Returns `undefined` when no tail columns
 * apply.
 */
export function tailColumnsFor<T extends string>(set: ColumnSet<T>, columns: readonly T[]): Set<string> | undefined {
  if (!set.tail) return undefined
  const result = new Set<string>()
  for (const col of columns) {
    if (set.tail.has(col)) result.add(col)
  }
  return result.size === 0 ? undefined : result
}
