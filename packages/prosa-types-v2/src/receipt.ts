import type { BundleCountsV2 } from './bundle.js'
import type { CanonicalEntityType } from './common.js'

export type PromotionReceiptV2Payload = {
  receiptVersion: 2
  receiptId: string
  protocolVersion: 2

  tenantId: string
  storeId: string
  storePath: string
  deviceId: string

  issuedAt: string
  serverRegion: string
  serverKeyId: string

  previousReceiptId: string | null
  previousBundleRoot: string | null

  bundleRoot: string
  rawSourceRoot: string

  counts: BundleCountsV2

  materialization: {
    postgresCommitId: string
    searchGenerationId: string
    rowCountsByEntity: Record<CanonicalEntityType, number>
  }

  verification: {
    uploadDigestVerified: true
    objectHashesVerifiedAtIngest: true
    projectionRowsLoaded: true
    noPerObjectHeadRequired: true
    backgroundAuditEligible: true
  }

  clientSignatureStatus: 'absent_v2_0'
}

export type PromotionReceiptV2Signature = {
  alg: 'Ed25519'
  keyId: string
  sig: string
}

export type PromotionReceiptV2 = {
  payload: PromotionReceiptV2Payload
  signature: PromotionReceiptV2Signature
}
