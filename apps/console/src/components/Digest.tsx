import { useId, useState } from 'react';
import { Icon } from './Icon.tsx';
import { useConsole } from '../app/context.tsx';

export function shortDigest(value: string): string {
  const raw = value.startsWith('sha256:') ? value.slice(7) : value;
  return raw.length <= 14 ? value : `${value.startsWith('sha256:') ? 'sha256:' : ''}${raw.slice(0, 12)}…`;
}

/**
 * Truncated identity/digest with keyboard-operable reveal and copy (UI-SPEC 5.1). The full value
 * never depends on hover. Copy announces success without moving focus.
 */
export function Digest({ value, label }: { value: string | null; label: string }) {
  const [revealed, setRevealed] = useState(false);
  const { announce } = useConsole();
  const id = useId();
  if (value === null) return <span className="muted">None</span>;
  const short = shortDigest(value);
  const truncated = short !== value;
  return (
    <span className="digest">
      <code id={id} className="mono digest-value">
        {revealed || !truncated ? value : short}
      </code>
      {truncated ? (
        <button
          type="button"
          className="btn-icon"
          aria-pressed={revealed}
          aria-controls={id}
          onClick={() => setRevealed((v) => !v)}
        >
          <Icon name="eye" />
          <span className="visually-hidden">
            {revealed ? 'Shorten' : 'Show full'} {label}
          </span>
        </button>
      ) : null}
      <button
        type="button"
        className="btn-icon"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => announce(`${label} copied`),
            () => announce(`Could not copy ${label}`),
          );
        }}
      >
        <Icon name="copy" />
        <span className="visually-hidden">Copy {label}</span>
      </button>
    </span>
  );
}
