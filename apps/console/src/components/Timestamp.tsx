/** Exact UTC timestamp with an explicit timezone (UI-SPEC 8). Relative time is never shown alone. */
export function formatUtc(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '')} UTC`;
}

export function Timestamp({ value, fallback = 'Not recorded' }: { value: string | null; fallback?: string }) {
  if (value === null) return <span className="muted">{fallback}</span>;
  return (
    <time className="mono" dateTime={value}>
      {formatUtc(value)}
    </time>
  );
}
