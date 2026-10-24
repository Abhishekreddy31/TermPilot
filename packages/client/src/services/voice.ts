export type VoiceState = 'idle' | 'listening';

export interface VoiceResult {
  transcript: string;
  isFinal: boolean;
}

type VoiceResultHandler = (result: VoiceResult) => void;
type VoiceStateHandler = (state: VoiceState) => void;

/**
 * How a spoken symbol joins its neighbours:
 * - `joiner`: glued on both sides (`readme dot md` → `readme.md`, `user at sign host` → `user@host`),
 *   except that it never glues onto the command word (`cat slash etc` → `cat /etc`) and a joiner
 *   with no word after it stands alone (`git add dot` → `git add .`)
 * - `path`: starts a path; space before, glued after (`cd dot dot slash src` → `cd ../src`)
 * - `prefix`: glued to what follows (`dash m` → `-m`, `double dash force` → `--force`)
 * - `open` / `close`: glued after / before (`open paren x close paren` → `(x)`)
 * - `quote`: alternates between open and close
 * - `separator`: spaces on both sides (`ls pipe wc` → `ls | wc`)
 * - `control`: a key such as Enter (sent as CR, like a keyboard) or Tab, no spaces around it
 * - `space`: an explicit space, to keep a joiner apart (`a dot space b`)
 */
type SymbolKind = 'joiner' | 'path' | 'prefix' | 'open' | 'close' | 'quote' | 'separator' | 'control' | 'space';

interface SpokenSymbol {
  text: string;
  kind: SymbolKind;
}

const SYMBOLS: Record<string, SpokenSymbol> = {
  'dash': { text: '-', kind: 'prefix' },
  'hyphen': { text: '-', kind: 'prefix' },
  'minus': { text: '-', kind: 'prefix' },
  'double dash': { text: '--', kind: 'prefix' },
  'dollar': { text: '$', kind: 'prefix' },
  'dollar sign': { text: '$', kind: 'prefix' },
  'hash': { text: '#', kind: 'prefix' },
  'pound': { text: '#', kind: 'prefix' },
  'star': { text: '*', kind: 'prefix' },
  'asterisk': { text: '*', kind: 'prefix' },
  'percent': { text: '%', kind: 'prefix' },
  'tilde': { text: '~', kind: 'path' },
  'tilde slash': { text: '~/', kind: 'path' },
  'dot slash': { text: './', kind: 'path' },
  'dot dot': { text: '..', kind: 'path' },
  'dot dot slash': { text: '../', kind: 'path' },
  'dot': { text: '.', kind: 'joiner' },
  'period': { text: '.', kind: 'joiner' },
  'slash': { text: '/', kind: 'joiner' },
  'backslash': { text: '\\', kind: 'joiner' },
  'colon': { text: ':', kind: 'joiner' },
  'at sign': { text: '@', kind: 'joiner' },
  'equals': { text: '=', kind: 'joiner' },
  'equal sign': { text: '=', kind: 'joiner' },
  'underscore': { text: '_', kind: 'joiner' },
  'pipe': { text: '|', kind: 'separator' },
  'ampersand': { text: '&', kind: 'separator' },
  'and sign': { text: '&', kind: 'separator' },
  'double ampersand': { text: '&&', kind: 'separator' },
  'greater than': { text: '>', kind: 'separator' },
  'less than': { text: '<', kind: 'separator' },
  'semicolon': { text: ';', kind: 'close' },
  'open paren': { text: '(', kind: 'open' },
  'close paren': { text: ')', kind: 'close' },
  'open bracket': { text: '[', kind: 'open' },
  'close bracket': { text: ']', kind: 'close' },
  'open brace': { text: '{', kind: 'open' },
  'close brace': { text: '}', kind: 'close' },
  'open quote': { text: '"', kind: 'open' },
  'close quote': { text: '"', kind: 'close' },
  'quote': { text: '"', kind: 'quote' },
  'single quote': { text: "'", kind: 'quote' },
  'tick': { text: "'", kind: 'quote' },
  'backtick': { text: '`', kind: 'quote' },
  'space': { text: ' ', kind: 'space' },
  'enter': { text: '\r', kind: 'control' },
  'return': { text: '\r', kind: 'control' },
  'newline': { text: '\r', kind: 'control' },
  'tab': { text: '\t', kind: 'control' },
};

/** Common misrecognitions. Multi-word entries apply anywhere; single words only as the command. */
const CORRECTIONS: Record<string, string> = {
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

const MAX_PHRASE_WORDS = Math.max(
  ...[...Object.keys(SYMBOLS), ...Object.keys(CORRECTIONS)].map((phrase) => phrase.split(' ').length),
);

interface Token {
  text: string;
  kind: SymbolKind | 'word';
}

/** Longest phrase in `table` starting at `words[i]`, as [phrase, word count]. */
function matchPhrase(words: string[], i: number, table: Record<string, unknown>, minWords = 1): [string, number] | null {
  for (let n = Math.min(MAX_PHRASE_WORDS, words.length - i); n >= minWords; n--) {
    const phrase = words.slice(i, i + n).join(' ');
    if (phrase in table) return [phrase, n];
  }
  return null;
}

function applyCorrections(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    const multi = matchPhrase(words, i, CORRECTIONS, 2);
    if (multi) {
      out.push(CORRECTIONS[multi[0]]);
      i += multi[1];
    } else {
      out.push(words[i]);
      i++;
    }
  }
  if (out.length > 0 && !out[0].includes(' ') && CORRECTIONS[out[0]]) out[0] = CORRECTIONS[out[0]];
  return out;
}

function tokenize(words: string[]): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < words.length; ) {
    const symbol = matchPhrase(words, i, SYMBOLS);
    if (symbol) {
      tokens.push({ ...SYMBOLS[symbol[0]] });
      i += symbol[1];
    } else {
      tokens.push({ text: words[i], kind: 'word' });
      i++;
    }
  }
  // Resolve alternating quotes into open/close pairs, per quote character.
  const openQuotes = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'quote') continue;
    if (openQuotes.has(token.text)) {
      openQuotes.delete(token.text);
      token.kind = 'close';
    } else {
      openQuotes.add(token.text);
      token.kind = 'open';
    }
  }
  return tokens;
}

const NO_SPACE_AFTER = new Set<Token['kind']>(['joiner', 'path', 'prefix', 'open', 'control', 'space']);
const NO_SPACE_BEFORE = new Set<Token['kind']>(['close', 'control', 'space']);

/** Whether a joiner at `index` should attach to the token before it. */
function joinerGluesLeft(tokens: Token[], index: number): boolean {
  if (index === 1 && tokens[0].kind === 'word') return false;
  return tokens.slice(index + 1).some((token) => token.kind === 'word');
}

/**
 * Turn a speech transcript into a shell command, e.g.
 * "git commit dash m hello" → `git commit -m hello`,
 * "cd tilde slash projects" → `cd ~/projects`.
 */
export function postProcessTranscript(raw: string): string {
  const words = raw.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const tokens = tokenize(applyCorrections(words));

  let out = '';
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1];
    const glued = !previous
      || NO_SPACE_AFTER.has(previous.kind)
      || NO_SPACE_BEFORE.has(token.kind)
      || (token.kind === 'joiner' && joinerGluesLeft(tokens, index));
    out += (glued ? '' : ' ') + token.text;
  });
  return out;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const scope = globalThis as unknown as Record<string, SpeechRecognitionConstructor | undefined>;
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** Commands, flags and the spoken-symbol grammar above are English, whatever the UI locale. */
const RECOGNITION_LANGUAGE = 'en-US';

export type VoiceAvailability = 'available' | 'insecure-context' | 'unsupported';

/** Browsers only expose speech recognition on HTTPS pages and localhost. */
export function voiceAvailability(): VoiceAvailability {
  if (!globalThis.isSecureContext) return 'insecure-context';
  return speechRecognitionConstructor() ? 'available' : 'unsupported';
}

export class VoiceService {
  private readonly recognition: SpeechRecognitionLike | null;
  private _state: VoiceState = 'idle';
  private readonly resultHandlers = new Set<VoiceResultHandler>();
  private readonly stateHandlers = new Set<VoiceStateHandler>();

  constructor(lang = RECOGNITION_LANGUAGE) {
    const Recognition = voiceAvailability() === 'available' ? speechRecognitionConstructor() : null;
    this.recognition = Recognition ? new Recognition() : null;
    if (!this.recognition) return;

    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.recognition.lang = lang;
    this.recognition.maxAlternatives = 1;
    this.recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      for (const handler of this.resultHandlers) handler({ transcript: result[0].transcript, isFinal: result.isFinal });
    };
    this.recognition.onend = () => this.setState('idle');
    this.recognition.onerror = () => this.setState('idle');
  }

  get available(): boolean {
    return this.recognition !== null;
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
      // Already started; onend will reset the state.
    }
  }

  stop(): void {
    if (!this.recognition) return;
    this.recognition.stop();
    this.setState('idle');
  }

  toggle(): void {
    if (this._state === 'listening') this.stop();
    else this.start();
  }

  onResult(handler: VoiceResultHandler): () => void {
    this.resultHandlers.add(handler);
    return () => this.resultHandlers.delete(handler);
  }

  onStateChange(handler: VoiceStateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  private setState(state: VoiceState): void {
    if (this._state === state) return;
    this._state = state;
    for (const handler of this.stateHandlers) handler(state);
  }
}
