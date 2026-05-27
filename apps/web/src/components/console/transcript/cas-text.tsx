import { useAppContext } from '~/app/providers.js'

export type CasTextProps = {
  /** CAS object id of the body (transcript block's `textObjectId`). */
  objectId: string
  /** Initial byte budget; kept for compatibility with existing call sites. */
  maxBytes?: number
  /** Optional className for the outer `<pre>`. */
  className?: string
}

/**
 * CQ-153 — explicit unavailable state without legacy tRPC fallback.
 *
 * Lane 6's `/v2/reads/artifacts/getText` is keyed by
 * `projection_artifact.artifact_id`. The v2 transcript surfaces
 * the CAS `textObjectId` per block but does not yet carry the
 * paired `artifactId`. Until the transcript schema is extended (or
 * a v2 endpoint accepts objectId lookups) we render an explicit
 * "expand unavailable" notice — never falling back to the legacy
 * tRPC `artifacts.getText.query({ objectId })`.
 *
 * The CAS object id is shown so an operator can correlate the body
 * with the CAS layer via the CLI (`prosa artifact get <objectId>`).
 */
export function CasText({ objectId, className }: CasTextProps) {
  const { tenantId } = useAppContext()
  if (!tenantId) return null
  return (
    <div>
      <pre className={className ?? 'transcript-tool-output'}>
        <em style={{ color: 'var(--color-text-muted)' }}>Expanding CAS-backed bodies is pending a v2 read surface.</em>
        {'\n'}
        <small style={{ color: 'var(--color-text-faint)' }}>CAS object id: {objectId}</small>
      </pre>
    </div>
  )
}
