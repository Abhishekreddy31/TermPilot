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
          data = String.fromCharCode(code - 64);
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
    <div class="extra-keys">
      {KEYS.map((key) => {
        const isActive =
          (key.label === 'Ctrl' && ctrlActive) ||
          (key.label === 'Alt' && altActive);

        return (
          <button
            key={key.label}
            class={`extra-key ${isActive ? 'toggle-active' : ''} ${key.action ? 'scroll-key' : ''}`}
            onClick={() => handleKey(key)}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );
}
