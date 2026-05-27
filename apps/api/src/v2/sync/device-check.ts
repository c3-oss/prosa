// CQ-127: shared device-ownership policy used by every v2
// promotion route that acts on an existing staging slot
// (UploadSegment, UploadObjectPack, SealPromotion,
// GetPromotionStatus). The policy is:
//
// 1. The caller must declare a device id via the
//    `x-prosa-device-id` header. Missing/empty → 400.
// 2. The device must be registered to the authenticated
//    (tenant_id, user_id). Foreign devices → 403
//    DEVICE_NOT_OWNED.
// 3. When the staging row records a device id, the requesting
//    device must match it. Mismatch → 403 DEVICE_MISMATCH.
//
// BeginPromotion is the only route that AUTO-REGISTERS a fresh
// device (because the staging row doesn't exist yet). Every
// other route requires the device to already be claimed.

import type { RawExec } from '../../db.js'

export type DeviceCheckOutcome =
  | { ok: true; deviceId: string }
  | { ok: false; code: 'DEVICE_REQUIRED' | 'DEVICE_NOT_OWNED'; message: string }

export async function verifyDeviceOwnership(
  deps: { rawExec: RawExec; tenantId: string; userId: string },
  rawDeviceId: string | string[] | undefined,
): Promise<DeviceCheckOutcome> {
  const deviceId = Array.isArray(rawDeviceId) ? rawDeviceId[0] : rawDeviceId
  if (!deviceId) {
    return {
      ok: false,
      code: 'DEVICE_REQUIRED',
      message: 'x-prosa-device-id header is required for this route (CQ-127)',
    }
  }
  const rows = await deps.rawExec<{ user_id: string }>(
    `SELECT user_id FROM device WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [deviceId, deps.tenantId],
  )
  if (rows.length === 0 || rows[0]!.user_id !== deps.userId) {
    return {
      ok: false,
      code: 'DEVICE_NOT_OWNED',
      message: `device ${deviceId} is not registered to the authenticated user in this tenant`,
    }
  }
  return { ok: true, deviceId }
}

export function buildDeviceMismatchPayload(stagingDeviceId: string, requestDeviceId: string) {
  return {
    code: 'DEVICE_MISMATCH' as const,
    message:
      `promotion is owned by device ${stagingDeviceId}; ` +
      `requesting device ${requestDeviceId} cannot act on it (CQ-127)`,
  }
}
