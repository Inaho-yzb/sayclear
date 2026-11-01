export function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path
          d="M10 8H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h3M22 8h3a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-3"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <path d="m13 20 6-8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </span>
  )
}
