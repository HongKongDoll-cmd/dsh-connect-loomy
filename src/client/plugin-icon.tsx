import type { CSSProperties, JSX } from 'react'

export function PluginIcon(props: { size?: number; className?: string; style?: CSSProperties }): JSX.Element {
  const size = props.size ?? 16
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      className={props.className}
      style={props.style}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="dsh-loomy-nav-bg" x1="16" y1="12" x2="112" y2="116" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3B82F6" />
          <stop offset="55%" stopColor="#6366F1" />
          <stop offset="100%" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <rect x="8" y="8" width="112" height="112" rx="28" fill="url(#dsh-loomy-nav-bg)" />
      <path d="M40 34C40 30.6863 42.6863 28 46 28H52C55.3137 28 58 30.6863 58 34V74H82C85.3137 74 88 76.6863 88 80V86C88 89.3137 85.3137 92 82 92H46C42.6863 92 40 89.3137 40 86V34Z" fill="#FFFFFF" />
      <path d="M84 26L87.2 34.8L96 38L87.2 41.2L84 50L80.8 41.2L72 38L80.8 34.8L84 26Z" fill="#FDE68A" />
    </svg>
  )
}
