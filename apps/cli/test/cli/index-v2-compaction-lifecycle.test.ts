// End-to-end compaction-lifecycle test for the `prosa v2 index`
// CLI group. Per-subcommand tests in `index-v2.test.ts` and the
// coherence test in `index-v2-coherence.test.ts` exercise discrete
// surfaces; this file walks the entire pure-TS compaction lifecycle
// as a single workflow and asserts that the audit chain is
// self-consistent at every step:
//
//   1. Plant projection segments → `compaction-plan` fires.
//   2. `compaction-manifest --write` atomically persists the manifest.
//   3. `superseded-segments` lists the now-recorded sources.
//   4. `compacted-outputs` reports `consistent: false` (runtime
//      worker has not landed yet — outputs missing).
//   5. `gc-plan` partitions every candidate as `blocked`.
//   6. Simulate the runtime worker by planting the compacted Parquet
//      file at the manifest's claimed `output_path`.
//   7. `compacted-outputs` flips to `consistent: true`.
//   8. `gc-plan` flips every candidate to `safe_to_delete: true`,
//      and the rollup totals move from `blocked` to `safe_to_delete`.
//
// Catches a class of cross-subcommand drift bugs that single-
// subcommand tests cannot.

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const CLI_ENTRY = join(__dirname, '..', '..', 'src', 'bin', 'prosa.ts')

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    'node',
    ['--conditions=prosa-dev', '--import', '@swc-node/register/esm-register', CLI_ENTRY, ...args],
    { encoding: 'utf8', timeout: 60_000 },
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

describe('prosa v2 index compaction-lifecycle (end-to-end)', () => {
  it('walks compaction-plan → manifest-write → superseded → compacted-outputs → gc-plan consistently', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-lifecycle-'))

    // 1. Plant 17 small `sessions.parquet` segments to fire the
    //    `low_count_byte_ceiling` compaction trigger.
    for (let epoch = 1; epoch <= 17; epoch++) {
      const dir = join(storeRoot, 'epochs', String(epoch), 'projection')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'sessions.parquet'), Buffer.alloc(1024))
    }

    // 2. Compaction plan should fire for sessions.
    const planResult = runCli(['v2', 'index', 'compaction-plan', '--store', storeRoot])
    expect(planResult.status).toBe(0)
    const plan = JSON.parse(planResult.stdout) as {
      empty: boolean
      entities: Array<{ entityType: string; reason: string; segmentsToMerge: unknown[] }>
    }
    expect(plan.empty).toBe(false)
    expect(plan.entities).toHaveLength(1)
    expect(plan.entities[0]?.entityType).toBe('sessions')
    expect(plan.entities[0]?.reason).toBe('low_count_byte_ceiling')
    expect(plan.entities[0]?.segmentsToMerge).toHaveLength(17)

    // 3. Persist the manifest.
    const writeResult = runCli([
      'v2',
      'index',
      'compaction-manifest',
      '--store',
      storeRoot,
      '--write',
      '--generated-at',
      '2026-05-19T12:00:00.000Z',
    ])
    expect(writeResult.status).toBe(0)
    const writeOut = JSON.parse(writeResult.stdout) as {
      manifest: { compaction_seq: number }
      persisted_path: string
    }
    expect(writeOut.manifest.compaction_seq).toBe(1)
    expect(writeOut.persisted_path).toContain('compact-0001')

    // 4. The persisted manifest is readable via `--read` and matches the write output.
    const readResult = runCli([
      'v2',
      'index',
      'compaction-manifest',
      '--store',
      storeRoot,
      '--read',
      '--compaction-seq',
      '1',
    ])
    expect(readResult.status).toBe(0)
    expect(JSON.parse(readResult.stdout)).toEqual(writeOut.manifest)

    // 5. `superseded-segments` lists every source segment the
    //    manifest recorded as merged-away.
    const supersededResult = runCli(['v2', 'index', 'superseded-segments', '--store', storeRoot])
    expect(supersededResult.status).toBe(0)
    const supersededRows = JSON.parse(supersededResult.stdout) as Array<{
      compaction_seq: number
      entity_type: string
      epoch: number
    }>
    expect(supersededRows).toHaveLength(17)
    expect(supersededRows.every((r) => r.compaction_seq === 1 && r.entity_type === 'sessions')).toBe(true)

    // 6. `compacted-outputs` reports inconsistent (runtime worker has not landed).
    const outputsBefore = runCli(['v2', 'index', 'compacted-outputs', '--store', storeRoot])
    expect(outputsBefore.status).toBe(0)
    const outputsBeforeRows = JSON.parse(outputsBefore.stdout) as Array<{ consistent: boolean }>
    expect(outputsBeforeRows[0]?.consistent).toBe(false)

    // 7. `gc-plan` partitions every superseded candidate as blocked.
    const gcBefore = runCli(['v2', 'index', 'gc-plan', '--store', storeRoot])
    expect(gcBefore.status).toBe(0)
    const gcBeforePlan = JSON.parse(gcBefore.stdout) as {
      candidates: Array<{ safe_to_delete: boolean; blocked_reason: string | null }>
      safe_to_delete: { count: number; bytes: number }
      blocked: { count: number; bytes: number }
    }
    expect(gcBeforePlan.candidates.every((c) => !c.safe_to_delete)).toBe(true)
    expect(gcBeforePlan.safe_to_delete).toEqual({ count: 0, bytes: 0 })
    expect(gcBeforePlan.blocked).toEqual({ count: 17, bytes: 17 * 1024 })

    // 8. Simulate the runtime worker — plant the compacted output file.
    const compactedDir = join(storeRoot, 'epochs', 'compact-0001', 'projection')
    await mkdir(compactedDir, { recursive: true })
    await writeFile(join(compactedDir, 'sessions.compacted.parquet'), Buffer.alloc(2048))

    // 9. `compacted-outputs` flips to consistent.
    const outputsAfter = runCli(['v2', 'index', 'compacted-outputs', '--store', storeRoot])
    expect(outputsAfter.status).toBe(0)
    const outputsAfterRows = JSON.parse(outputsAfter.stdout) as Array<{
      consistent: boolean
      entity_outputs: Array<{ exists: boolean; byte_length: number | null }>
    }>
    expect(outputsAfterRows[0]?.consistent).toBe(true)
    expect(outputsAfterRows[0]?.entity_outputs[0]?.exists).toBe(true)
    expect(outputsAfterRows[0]?.entity_outputs[0]?.byte_length).toBe(2048)

    // 10. `gc-plan` flips every candidate to safe_to_delete, totals move.
    const gcAfter = runCli(['v2', 'index', 'gc-plan', '--store', storeRoot])
    expect(gcAfter.status).toBe(0)
    const gcAfterPlan = JSON.parse(gcAfter.stdout) as {
      candidates: Array<{ safe_to_delete: boolean; blocked_reason: string | null }>
      safe_to_delete: { count: number; bytes: number }
      blocked: { count: number; bytes: number }
    }
    expect(gcAfterPlan.candidates.every((c) => c.safe_to_delete)).toBe(true)
    expect(gcAfterPlan.candidates.every((c) => c.blocked_reason === null)).toBe(true)
    expect(gcAfterPlan.safe_to_delete).toEqual({ count: 17, bytes: 17 * 1024 })
    expect(gcAfterPlan.blocked).toEqual({ count: 0, bytes: 0 })
  }, 180_000)
})
