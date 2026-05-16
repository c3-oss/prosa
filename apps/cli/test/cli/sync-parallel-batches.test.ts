import type { PromotionReceipt } from '@c3-oss/prosa-sync'
import { describe, expect, it } from 'vitest'
import type { ProsaApiClient } from '../../src/cli/auth/client.js'
import { promoteChunkedUpload } from '../../src/cli/commands/sync.js'
import { createTempBundle } from '../helpers/tmp-bundle.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function receiptFor(input: {
  batchId: string
  deviceId: string
  storePath: string
  declaredSessionIds: string[]
}): PromotionReceipt {
  return {
    batchId: input.batchId,
    tenantId: 'tenant-1',
    deviceId: input.deviceId,
    storePath: input.storePath,
    manifestHash: `manifest-${input.batchId}`,
    sessionCount: input.declaredSessionIds.length,
    objectCount: 0,
    searchDocCount: 0,
    batchObjectCount: 0,
    batchSourceFileCount: 0,
    batchRawRecordCount: 0,
    batchSessionCount: input.declaredSessionIds.length,
    batchSearchDocCount: 0,
    batchToolCallCount: 0,
    batchToolResultCount: 0,
    declaredObjectsVerified: 0,
    declaredSourceFilesVerified: 0,
    declaredRawRecordsVerified: 0,
    declaredSessionsVerified: input.declaredSessionIds.length,
    declaredSearchDocsVerified: 0,
    declaredToolCallsVerified: 0,
    declaredToolResultsVerified: 0,
    cleanupEligible: false,
    verifiedAt: '2026-05-16T00:00:00.000Z',
  }
}

describe('chunked sync batch concurrency', () => {
  it('parallelizes independent batches while keeping the logical final receipt last', async () => {
    const temp = await createTempBundle()
    try {
      for (const id of ['sess-1', 'sess-2', 'sess-3']) {
        temp.bundle.db
          .prepare(
            `INSERT INTO sessions (session_id, source_tool, source_session_id, project_id, title, start_ts, end_ts)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, 'codex', id, null, id, null, null)
      }

      let activePlans = 0
      let maxActivePlans = 0
      let nextBatch = 1
      const verifiedSessionGroups: string[][] = []
      const client = {
        syncPlanUpload: async () => {
          activePlans += 1
          maxActivePlans = Math.max(maxActivePlans, activePlans)
          const batchId = `batch-${nextBatch}`
          nextBatch += 1
          await delay(20)
          activePlans -= 1
          return { batchId, missingObjectIds: [], uploadUrlTemplate: '/objects/:objectId' }
        },
        uploadObjectBytes: async () => undefined,
        syncCommitUpload: async (input: { batchId: string; projection: { sessions: unknown[] } }) => ({
          batchId: input.batchId,
          committedObjects: 0,
          committedRows: input.projection.sessions.length,
        }),
        syncVerifyPromotion: async (input: {
          batchId: string
          storePath: string
          declaredSessionIds: string[]
        }) => {
          verifiedSessionGroups.push(input.declaredSessionIds)
          return {
            receipt: receiptFor({
              batchId: input.batchId,
              deviceId: 'device-1',
              storePath: input.storePath,
              declaredSessionIds: input.declaredSessionIds,
            }),
            sampledSessions: [],
          }
        },
      } as unknown as ProsaApiClient

      const result = await promoteChunkedUpload({
        client,
        deviceId: 'device-1',
        storePath: temp.path,
        bundle: temp.bundle,
        maxObjectsPerPlan: 1,
        maxRowsPerCommit: 1,
        objectConcurrency: 1,
        batchConcurrency: 2,
      })

      expect(maxActivePlans).toBe(2)
      expect(result.batchCount).toBe(3)
      expect(result.metrics.batches).toBe(3)
      expect(result.metrics.rowsCommitted).toBe(3)
      expect(verifiedSessionGroups.at(-1)).toEqual(['sess-3'])
      expect(result.batchId).toBe('batch-3')
    } finally {
      await temp.cleanup()
    }
  })
})
