import { useState, useCallback } from 'preact/hooks';

interface ExtraKeysProps {
  onKey: (data: string) => void;
  onScrollUp?: () => void;
  onScrollDown?: () => void;
}

interface KeyDef {
  label: string;
  data: string;
  toggle?: boolean;
  action?: string;
}

const KEYS: KeyDef[] = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl', data: '', toggle: true },
  { label: 'Alt', data: '', toggle: true },
  { label: '\u2191', data: '\x1b[A' },  // Up arrow
  { label: '\u2193', data: '\x1b[B' },  // Down arrow
  { label: '\u2190', data: '\x1b[D' },  // Left arrow
  { label: '\u2192', data: '\x1b[C' },  // Right arrow
  { label: '|', data: '|' },
  { label: '/', data: '/' },
  { label: '~', data: '~' },
  { label: '-', data: '-' },
  { label: '.', data: '.' },
  { label: 'PgUp', data: '', action: 'scrollUp' },
  { label: 'PgDn', data: '', action: 'scrollDown' },
];

export function ExtraKeys({ onKey, onScrollUp, onScrollDown }: ExtraKeysProps) {
  const [ctrlActive, setCtrlActive] = useState(false);
  const [altActive, setAltActive] = useState(false);

  const handleKey = useCallback(
    (key: KeyDef) => {
      if (key.action === 'scrollUp') {
        onScrollUp?.();
        return;
      }
      if (key.action === 'scrollDown') {
        onScrollDown?.();
        return;
      }
      if (key.label === 'Ctrl') {
        setCtrlActive((v) => !v);
        return;
      }
      if (key.label === 'Alt') {
        setAltActive((v) => !v);
        return;
      }

      let data = key.data;

      if (ctrlActive && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 65 && code <= 90) {
          // Ctrl+A=0x01 ... Ctrl+Z=0x1A
          data = String.fromCharCode(code - 64);
        } else {
          // Ctrl+[ = Escape, Ctrl+] = 0x1D, Ctrl+\ = 0x1C, Ctrl+^ = 0x1E
          const special: Record<string, string> = { '[': '\x1b', ']': '\x1d', '\\': '\x1c', '^': '\x1e', '/': '\x1f' };
          if (special[data]) data = special[data];
        }
        setCtrlActive(false);
      }

      if (altActive) {
        data = '\x1b' + data;
        setAltActive(false);
      }

      onKey(data);
    },
    [ctrlActive, altActive, onKey, onScrollUp, onScrollDown]
  );

  return (
    <div class="extra-keys" role="toolbar" aria-label="Terminal extra keys">
      {KEYS.map((key) => {
        const isActive =
          (key.label === 'Ctrl' && ctrlActive) ||
          (key.label === 'Alt' && altActive);

        const ariaLabel = key.action === 'scrollUp' ? 'Page Up' :
          key.action === 'scrollDown' ? 'Page Down' :
          key.toggle ? `${key.label} modifier${isActive ? ' (active)' : ''}` :
          `${key.label} key`;

        return (
          <button
            key={key.label}
            class={`extra-key ${isActive ? 'toggle-active' : ''} ${key.action ? 'scroll-key' : ''}`}
            onClick={() => handleKey(key)}
            aria-label={ariaLabel}
            aria-pressed={key.toggle ? isActive : undefined}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );
}
