import type { IconProps } from './icons/props.ts'

/** Display options for the Giana CoWork Preview (GCP) wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading Giana OS mark; defaults to true. */
  includeMark?: boolean | undefined
}

/** Render the GCP wordmark with its visible Preview designation. */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const releaseVersion = (globalThis as { __GIANA_DESKTOP__?: { releaseVersion?: unknown } }).__GIANA_DESKTOP__?.releaseVersion
  const version = typeof releaseVersion === 'string' && /^0\.1\.1-rc\.\d+$/.test(releaseVersion) ? releaseVersion : undefined
  return (
    <span
      className={className}
      aria-label="Giana CoWork Preview"
      style={{ display: 'inline-flex', alignItems: 'center', gap: Math.max(6, size / 3), minWidth: 0, minHeight: Math.max(40, size), textAlign: 'left' }}
    >
      {includeMark && <GianaMark size={size} />}
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
        <span style={{ fontSize: Math.max(14, Math.round(size * 0.7)), fontWeight: 650, lineHeight: 1.2, overflowWrap: 'anywhere' }}>
          Giana CoWork
        </span>
        <span style={{ fontSize: 12, fontWeight: 500, lineHeight: '16px' }}>Preview</span>
        {version && <span style={{ fontSize: 11, fontWeight: 500, lineHeight: '14px', color: '#53625a' }}>v{version}</span>}
      </span>
    </span>
  )
}

function GianaMark({ size }: { size: number }) {
  return <img src="/giana-cowork-logo.png" width={size} height={size} alt="" aria-hidden="true" style={{ flex: 'none', objectFit: 'contain' }} />
}
