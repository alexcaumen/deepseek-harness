import type { IconProps } from './icons/props.ts'

/** Render the user-provided logo used by Giana CoWork Preview (GCP). */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <img
      src="/giana-cowork-logo.png"
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      style={{ objectFit: 'contain' }}
    />
  )
}
