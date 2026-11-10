export function MeetClipIcon({ size = 20, active = false }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      style={{
        display: 'block',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)'
      }}
    >
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="5">
        <path d="M17 27v10" />
        <path d="M26 20v24" />
        <path d="M35 25v14" />
        <path d="M44 29v6" />
      </g>
      <path d="M49 8h7v14l-3.5-2.7L49 22V8Z" fill="currentColor" />
    </svg>
  )
}

export function RefreshIcon({ size = 14, spinning = false }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      className={spinning ? 'mc-spin' : undefined}
      style={{ display: 'block' }}
    >
      <path
        d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SearchIcon({ size = 14 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: 'block' }}>
      <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m15.5 15.5 5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
