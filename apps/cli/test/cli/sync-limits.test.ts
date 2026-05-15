import type { Bundle } from '@c3-oss/prosa-core'
import { describe, expect, it } from 'vitest'
import { readUploadCounts, uploadLimitViolations } from '../../src/cli/sync/limits.js'

type QueryFixture = {
  sqlIncludes: string
  count: number | bigint
}

function fakeBundle(fixtures: QueryFixture[]): Bundle {
  return {
    db: {
      prepare: (sql: string) => ({
        get: (...params: unknown[]) => {
          if (sql.includes('FROM objects') && sql.includes('size_bytes > ?')) {
            expect(params).toEqual([10, 10])
            const fixture = fixtures.find((entry) => entry.sqlIncludes === 'size_bytes > ?')
            return fixture ? { count: fixture.count } : undefined
          }
          const fixture = fixtures.find((entry) => sql.includes(entry.sqlIncludes))
          return fixture ? { count: fixture.count } : undefined
        },
      }),
    },
  } as unknown as Bundle
}

describe('readUploadCounts', () => {
  it('reads every projection and CAS count and calculates total rows', () => {
    const counts = readUploadCounts(
      fakeBundle([
        { sqlIncludes: 'FROM sessions', count: 2 },
        { sqlIncludes: 'FROM search_docs', count: 3n },
        { sqlIncludes: 'FROM source_files', count: 5 },
        { sqlIncludes: 'FROM raw_records', count: 7n },
        { sqlIncludes: 'FROM objects', count: 11 },
        { sqlIncludes: 'size_bytes > ?', count: 13 },
      ]),
      { maxObjectsPerPlan: 100, maxRowsPerCommit: 100, maxObjectBytes: 10 },
    )

    expect(counts).toEqual({
      sessions: 2,
      searchDocs: 3,
      sourceFiles: 5,
      rawRecords: 7,
      casObjects: 11,
      totalRows: 17,
      oversizedCasObjects: 13,
    })
  })

  it('treats missing count rows as zero', () => {
    const counts = readUploadCounts(fakeBundle([]), {
      maxObjectsPerPlan: 100,
      maxRowsPerCommit: 100,
      maxObjectBytes: 10,
    })

    expect(counts).toEqual({
      sessions: 0,
      searchDocs: 0,
      sourceFiles: 0,
      rawRecords: 0,
      casObjects: 0,
      totalRows: 0,
      oversizedCasObjects: 0,
    })
  })
})

describe('uploadLimitViolations', () => {
  it('returns every violated server limit', () => {
    expect(
      uploadLimitViolations(
        {
          sessions: 4,
          searchDocs: 3,
          sourceFiles: 2,
          rawRecords: 1,
          casObjects: 6,
          totalRows: 10,
          oversizedCasObjects: 2,
        },
        { maxObjectsPerPlan: 5, maxRowsPerCommit: 9, maxObjectBytes: 10 },
      ),
    ).toEqual([
      'CAS object count 6 exceeds server maxObjectsPerPlan 5',
      'projection row count 10 exceeds server maxRowsPerCommit 9',
      '2 CAS object(s) exceed server maxObjectBytes 10',
    ])
  })

  it('returns no violations when counts are at the limits', () => {
    expect(
      uploadLimitViolations(
        {
          sessions: 0,
          searchDocs: 0,
          sourceFiles: 0,
          rawRecords: 0,
          casObjects: 5,
          totalRows: 9,
          oversizedCasObjects: 0,
        },
        { maxObjectsPerPlan: 5, maxRowsPerCommit: 9, maxObjectBytes: 10 },
      ),
    ).toEqual([])
  })
})
