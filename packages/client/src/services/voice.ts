export type VoiceState = 'idle' | 'listening' | 'processing';

export interface VoiceResult {
  transcript: string;
  isFinal: boolean;
}

type VoiceResultHandler = (result: VoiceResult) => void;
type VoiceStateHandler = (state: VoiceState) => void;

// Symbol mapping for terminal commands
const SYMBOL_MAP: Record<string, string> = {
  'dash': '-',
  'hyphen': '-',
  'double dash': '--',
  'dot': '.',
  'period': '.',
  'slash': '/',
  'backslash': '\\',
  'tilde': '~',
  'star': '*',
  'asterisk': '*',
  'pipe': '|',
  'ampersand': '&',
  'and sign': '&',
  'double ampersand': '&&',
  'at sign': '@',
  'at': '@',
  'hash': '#',
  'pound': '#',
  'dollar sign': '$',
  'dollar': '$',
  'percent': '%',
  'equals': '=',
  'equal sign': '=',
  'colon': ':',
  'semicolon': ';',
  'greater than': '>',
  'less than': '<',
  'open quote': '"',
  'close quote': '"',
  'quote': '"',
  'single quote': "'",
  'tick': "'",
  'backtick': '`',
  'open paren': '(',
  'close paren': ')',
  'open bracket': '[',
  'close bracket': ']',
  'open brace': '{',
  'close brace': '}',
  'space': ' ',
  'enter': '\n',
  'return': '\n',
  'newline': '\n',
  'tab': '\t',
};

// Common command corrections
const COMMAND_CORRECTIONS: Record<string, string> = {
  'get': 'git',
  'gig': 'git',
  'good': 'git',
  'pseudo': 'sudo',
  'sue do': 'sudo',
  'dock her': 'docker',
  'doctor': 'docker',
  'note': 'node',
  'cube cuddle': 'kubectl',
  'cube control': 'kubectl',
};

export class VoiceService {
  private recognition: SpeechRecognition | null = null;
  private _state: VoiceState = 'idle';
  private resultHandlers: VoiceResultHandler[] = [];
  private stateHandlers: VoiceStateHandler[] = [];
  private _available: boolean;

  constructor() {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    this._available = !!SpeechRecognition;

    if (SpeechRecognition) {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = false;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';
      this.recognition.maxAlternatives = 1;

      this.recognition.onresult = (event: SpeechRecognitionEvent) => {
        const result = event.results[event.results.length - 1];
        const transcript = result[0].transcript;
        const isFinal = result.isFinal;

        this.emit({ transcript, isFinal });
      };

      this.recognition.onend = () => {
        this.setState('idle');
      };

      this.recognition.onerror = () => {
        this.setState('idle');
      };
    }
  }

  get available(): boolean {
    return this._available;
  }

  get state(): VoiceState {
    return this._state;
  }

  start(): void {
    if (!this.recognition || this._state === 'listening') return;
    try {
      this.recognition.start();
      this.setState('listening');
    } catch {
      // Already started
    }
  }

  stop(): void {
    if (!this.recognition) return;
    this.recognition.stop();
    this.setState('idle');
  }

  toggle(): void {
    if (this._state === 'listening') {
      this.stop();
    } else {
      this.start();
    }
  }

  onResult(handler: VoiceResultHandler): () => void {
    this.resultHandlers.push(handler);
    return () => {
      const idx = this.resultHandlers.indexOf(handler);
      if (idx >= 0) this.resultHandlers.splice(idx, 1);
    };
  }

  onStateChange(handler: VoiceStateHandler): () => void {
    this.stateHandlers.push(handler);
    return () => {
      const idx = this.stateHandlers.indexOf(handler);
      if (idx >= 0) this.stateHandlers.splice(idx, 1);
    };
  }

  private emit(result: VoiceResult): void {
    for (const handler of this.resultHandlers) {
      handler(result);
    }
  }

  private setState(state: VoiceState): void {
    if (this._state === state) return;
    this._state = state;
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }
}

export function postProcessTranscript(raw: string): string {
  let text = raw.toLowerCase().trim();

  // Apply symbol mapping (longer phrases first, whole words only)
  const sortedSymbols = Object.keys(SYMBOL_MAP).sort(
    (a, b) => b.length - a.length
  );
  for (const phrase of sortedSymbols) {
    const regex = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    text = text.replace(regex, SYMBOL_MAP[phrase]);
  }

  // Apply multi-word command corrections first (longer phrases first)
  const sortedCorrections = Object.keys(COMMAND_CORRECTIONS).sort(
    (a, b) => b.length - a.length
  );
  for (const phrase of sortedCorrections) {
    if (phrase.includes(' ')) {
      const regex = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      text = text.replace(regex, COMMAND_CORRECTIONS[phrase]);
    }
  }

  // Apply single-word command corrections (first word only)
  const words = text.split(/\s+/);
  if (words.length > 0 && COMMAND_CORRECTIONS[words[0]]) {
    words[0] = COMMAND_CORRECTIONS[words[0]];
  }

  return words.join(' ');
}
