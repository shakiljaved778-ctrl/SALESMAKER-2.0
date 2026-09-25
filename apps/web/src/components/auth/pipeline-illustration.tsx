/** Decorative pipeline board in the brand panel: shapes only, drawn in currentColor. */
export function PipelineIllustration({ className }: { className?: string }) {
  const columns = [3, 2, 4, 1];
  return (
    <svg viewBox="0 0 400 220" className={className} aria-hidden="true" focusable="false">
      {columns.map((cards, col) => (
        <g key={col} transform={`translate(${String(col * 100)} 0)`}>
          <rect x="4" y="0" width="88" height="10" rx="5" fill="currentColor" opacity="0.35" />
          {Array.from({ length: cards }, (_, i) => (
            <g key={i} transform={`translate(4 ${String(22 + i * 48)})`}>
              <rect width="88" height="40" rx="8" fill="currentColor" opacity="0.14" />
              <rect x="10" y="10" width="48" height="6" rx="3" fill="currentColor" opacity="0.6" />
              <rect x="10" y="24" width="30" height="6" rx="3" fill="currentColor" opacity="0.3" />
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
}
