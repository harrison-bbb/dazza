/** The Dazza mark: a green block with a cut-out "D". */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <path d="M9 8h8a7 7 0 0 1 0 14h-8z" fill="var(--accent-ink)" />
    </svg>
  );
}
