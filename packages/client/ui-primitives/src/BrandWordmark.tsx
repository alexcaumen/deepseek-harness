import type { IconProps } from './icons/props.ts'

/** Display options for the Giana CoWork wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading Giana OS mark; defaults to true. */
  includeMark?: boolean | undefined
}

/** Render the public Giana CoWork product mark. */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  return (
    <span
      className={className}
      aria-label="Giana CoWork"
      style={{ display: 'inline-flex', alignItems: 'center', gap: Math.max(6, size / 3), height: size }}
    >
      {includeMark && <GianaMark size={size} />}
      <span style={{ fontSize: Math.max(14, size * 0.78), fontWeight: 650, lineHeight: 1, whiteSpace: 'nowrap' }}>
        Giana CoWork
      </span>
    </span>
  )
}

function GianaMark({ size }: { size: number }) {
  return <img src="/giana-cowork-logo.png" width={size} height={size} alt="" aria-hidden="true" style={{ objectFit: 'contain' }} />
}
