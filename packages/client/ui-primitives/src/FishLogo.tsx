import type { IconProps } from './icons/props.ts'

/** Render the Giana OS mark used by the Giana Code workbench. */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <img
      src="/giana-os-logo.png"
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      style={{ objectFit: 'contain' }}
    />
  )
}
