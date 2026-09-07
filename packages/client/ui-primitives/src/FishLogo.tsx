// NEO "N" mark. Native 23.16x17.04, rendered 24x18 by default; hero usage
// scales to 34x25. Color rides currentColor (wordmark ink).

import type { IconProps } from './icons/props.ts'

/**
 * Render the fish logo.
 * @param props.size - width in px (default 24; height keeps the 23.16:17.04 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={(size * 17.04) / 23.16}
      className={className}
      viewBox="0 0 23.16 17.04"
      fill="none"
      aria-hidden="true"
    >
      <path d="M2 16 V1 h3.2 l12.76 11.5 V1 h3.2 v15 h-3.2 L5.2 4.5 V16 Z" fill="currentColor"/>
    </svg>
  )
}
