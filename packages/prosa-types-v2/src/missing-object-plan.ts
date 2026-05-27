export type MissingObjectPlanV2 = {
  objectSetRoot: string
  inventoryDigest: string
  ordering: 'hash_alg_hash_hex_size_compression_ascending'
  encoding: 'none' | 'range_list' | 'roaring_bitmap_zstd'
  objectCount: number
  payloadBase64?: string
}
