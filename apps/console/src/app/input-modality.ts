/**
 * Records whether the last user interaction was keyboard or pointer on the root element as
 * `data-input-modality`. Programmatic focus targets (route headings, error summaries, drawer
 * headings; all `tabindex="-1"`) show a focus ring only after keyboard interaction, so a mouse
 * user or a fresh page load does not see a boxed heading while screen-reader focus still moves.
 * Interactive controls keep their `:focus-visible` ring regardless.
 */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

export function trackInputModality(doc: Document): void {
  const root = doc.documentElement;
  const set = (mode: 'keyboard' | 'pointer') => {
    if (root.dataset['inputModality'] !== mode) root.dataset['inputModality'] = mode;
  };
  doc.addEventListener(
    'keydown',
    (e) => {
      if (!MODIFIER_KEYS.has(e.key)) set('keyboard');
    },
    true,
  );
  doc.addEventListener('pointerdown', () => set('pointer'), true);
}
