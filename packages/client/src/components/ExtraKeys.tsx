import type { Modifiers } from '../services/keys.js';

type ModifierName = keyof Modifiers;

type KeyDef =
  | { kind: 'key'; label: string; ariaLabel: string; data: string }
  | { kind: 'modifier'; label: string; modifier: ModifierName }
  | { kind: 'page'; label: string; ariaLabel: string; direction: -1 | 1 };

const KEYS: KeyDef[] = [
  { kind: 'key', label: 'Esc', ariaLabel: 'Escape', data: '\x1b' },
  { kind: 'key', label: 'Tab', ariaLabel: 'Tab', data: '\t' },
  { kind: 'modifier', label: 'Ctrl', modifier: 'ctrl' },
  { kind: 'modifier', label: 'Alt', modifier: 'alt' },
  { kind: 'key', label: '↑', ariaLabel: 'Up arrow', data: '\x1b[A' },
  { kind: 'key', label: '↓', ariaLabel: 'Down arrow', data: '\x1b[B' },
  { kind: 'key', label: '←', ariaLabel: 'Left arrow', data: '\x1b[D' },
  { kind: 'key', label: '→', ariaLabel: 'Right arrow', data: '\x1b[C' },
  { kind: 'key', label: '|', ariaLabel: 'Pipe', data: '|' },
  { kind: 'key', label: '/', ariaLabel: 'Slash', data: '/' },
  { kind: 'key', label: '~', ariaLabel: 'Tilde', data: '~' },
  { kind: 'key', label: '-', ariaLabel: 'Dash', data: '-' },
  { kind: 'key', label: '.', ariaLabel: 'Dot', data: '.' },
  { kind: 'page', label: 'PgUp', ariaLabel: 'Page up', direction: -1 },
  { kind: 'page', label: 'PgDn', ariaLabel: 'Page down', direction: 1 },
];

interface ExtraKeysProps {
  modifiers: Modifiers;
  onToggleModifier: (modifier: ModifierName) => void;
  /** A key the phone keyboard lacks; modifiers are applied by the receiver, as for typed keys. */
  onKey: (data: string) => void;
  onPage: (direction: -1 | 1) => void;
}

/** Keys missing from phone keyboards. Ctrl and Alt arm for the next keystroke, typed or tapped. */
export function ExtraKeys({ modifiers, onToggleModifier, onKey, onPage }: ExtraKeysProps) {
  return (
    <div class="extra-keys" role="toolbar" aria-label="Extra keys">
      {KEYS.map((key) => {
        if (key.kind === 'modifier') {
          const active = modifiers[key.modifier];
          return (
            <button
              key={key.label}
              type="button"
              class={`extra-key ${active ? 'toggle-active' : ''}`}
              aria-pressed={active}
              aria-label={`${key.label} modifier`}
              // Keep focus (and the phone keyboard) on the terminal.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onToggleModifier(key.modifier)}
            >
              {key.label}
            </button>
          );
        }
        return (
          <button
            key={key.label}
            type="button"
            class={`extra-key ${key.kind === 'page' ? 'scroll-key' : ''}`}
            aria-label={key.ariaLabel}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (key.kind === 'page' ? onPage(key.direction) : onKey(key.data))}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );
}
