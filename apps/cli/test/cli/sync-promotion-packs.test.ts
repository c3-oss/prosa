import type { ObjectManifestEntry, ProjectionPayload } from '@c3-oss/prosa-sync'
import { describe, expect, it } from 'vitest'
import type { ProsaApiClient } from '../../src/cli/auth/client.js'
import type { LocalBundleUpload, LocalCasObject } from '../../src/cli/sync/bundle.js'
import { promoteUpload, splitMissingObjectUploads } from '../../src/cli/sync/promotion.js'

function entry(hashChar: string, size: number, overrides: Partial<ObjectManifestEntry> = {}): ObjectManifestEntry {
  const hash = hashChar.repeat(64)
  return {
    objectId: `blake3:${hash}`,
    hash,
    hashAlgorithm: 'blake3',
    compression: 'none',
    compressedSize: size,
    uncompressedSize: size,
    transportHash: hash,
    ...overrides,
  }
}

function cas(hashChar: string, bytes: number[], overrides: Partial<ObjectManifestEntry> = {}): LocalCasObject {
  return {
    entry: entry(hashChar, bytes.length, overrides),
    bytes: new Uint8Array(bytes),
  }
}

function emptyProjection(): ProjectionPayload {
  return { sourceFiles: [], rawRecords: [], sessions: [], searchDocs: [], toolCalls: [], toolResults: [] }
}

describe('CLI sync object pack uploads', () => {
  it('splits pack-compatible objects from PUT fallbacks', () => {
    const smallA = cas('a', [1, 2, 3])
    const smallB = cas('b', [4, 5])
    const oversized = cas('c', [6, 7, 8, 9, 10, 11])
    const incompatible = cas('d', [12, 13], { compressedSize: 3 })

    const split = splitMissingObjectUploads([smallA, smallB, oversized, incompatible], 5)

    expect(split.packs.map((pack) => pack.map(({ entry }) => entry.objectId))).toEqual([
      [smallA.entry.objectId, smallB.entry.objectId],
    ])
    expect(split.putObjects.map(({ entry }) => entry.objectId)).toEqual([
      oversized.entry.objectId,
      incompatible.entry.objectId,
    ])
  })

  it('uploads missing compatible objects as packs before PUT fallbacks', async () => {
    const smallA = cas('a', [1, 2])
    const smallB = cas('b', [3, 4, 5])
    const oversized = cas('c', [6, 7, 8, 9, 10, 11])
    const incompatible = cas('d', [12, 13], { compressedSize: 3 })
    const casObjects = [smallA, smallB, oversized, incompatible]
    const events: string[] = []

    const client = {
      syncPlanUpload: async () => {
        events.push('plan')
        return {
          batchId: 'batch-1',
          missingObjectIds: casObjects.map(({ entry }) => entry.objectId),
          uploadUrlTemplate: '/objects/:objectId',
        }
      },
      uploadObjectPack: async ({ objects }: { objects: Array<ObjectManifestEntry & { bytes: Uint8Array }> }) => {
        events.push(`pack:${objects.map((object) => object.objectId).join(',')}`)
        return {
          blobId: 'object-pack:t:batch-1:hash',
          objectIds: objects.map((object) => object.objectId),
          alreadyExisted: false,
        }
      },
      uploadObjectBytes: async ({ objectId }: { objectId: string }) => {
        events.push(`put:${objectId}`)
        return { alreadyExisted: false }
      },
      syncCommitUpload: async () => {
        events.push('commit')
        return { committedObjects: casObjects.length, committedRows: 0 }
      },
      syncVerifyPromotion: async () => {
        events.push('verify')
        return {
          receipt: {
            batchId: 'batch-1',
            tenantId: 'tenant-1',
            storePath: '/tmp/.prosa',
            verifiedAt: '2026-05-16T00:00:00.000Z',
            sessionCount: 0,
            objectCount: casObjects.length,
            searchDocCount: 0,
          },
        }
      },
    } as unknown as ProsaApiClient
    const upload: LocalBundleUpload = {
      projection: emptyProjection(),
      sessions: [],
      searchDocs: [],
      sourceFiles: [],
      rawRecords: [],
      toolCalls: [],
      toolResults: [],
      casObjects,
    }

    await promoteUpload({
      client,
      deviceId: 'device-1',
      storePath: '/tmp/.prosa',
      upload,
      maxObjectPackBytes: 5,
    })

    expect(events).toEqual([
      'plan',
      `pack:${smallA.entry.objectId},${smallB.entry.objectId}`,
      `put:${oversized.entry.objectId}`,
      `put:${incompatible.entry.objectId}`,
      'commit',
      'verify',
    ])
  })
})
