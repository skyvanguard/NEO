// NEO brand wordmark: a clean phosphor-terminal "NEO" wordmark. Ink rides
// currentColor so it inherits the brand accent (Matrix green) in both themes.
// Native 72x24, aspect-locked to the requested height.

import type { IconProps } from './icons/props.ts'

/**
 * Render the NEO wordmark.
 * @param props.size - height in px (default 24; width keeps the 72:24 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={(size * 72) / 24}
      height={size}
      className={className}
      viewBox="0 0 72 24"
      fill="none"
      aria-hidden="true"
    >
      <text
        x="1"
        y="18.5"
        fill="currentColor"
        style={{
          fontFamily: 'var(--ds-font-family-code)',
          fontSize: '19px',
          fontWeight: 800,
          letterSpacing: '3.5px',
        }}
      >
        NEO
      </text>
    </svg>
  )
}
