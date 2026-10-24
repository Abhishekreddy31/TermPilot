import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceService, postProcessTranscript, voiceAvailability } from '../../../packages/client/src/services/voice.js';

describe('postProcessTranscript', () => {
  it.each([
    // The examples promised in the README.
    ['git status', 'git status'],
    ['git commit dash m hello', 'git commit -m hello'],
    ['ls pipe grep test', 'ls | grep test'],
    ['cd tilde slash projects', 'cd ~/projects'],
    ['pseudo apt install node', 'sudo apt install node'],
    ['dock her ps', 'docker ps'],
  ])('README example: %s', (spoken, command) => {
    expect(postProcessTranscript(spoken)).toBe(command);
  });

  it.each([
    ['ls dash la', 'ls -la'],
    ['git push double dash force', 'git push --force'],
    ['cat readme dot md', 'cat readme.md'],
    ['git add dot', 'git add .'],
    ['cd dot dot', 'cd ..'],
    ['cd dot dot slash src', 'cd ../src'],
    ['rm dash rf dot slash build', 'rm -rf ./build'],
    ['vim tilde slash dot zshrc', 'vim ~/.zshrc'],
    ['cat slash etc slash hosts', 'cat /etc/hosts'],
    ['ls src slash main', 'ls src/main'],
    ['ssh deploy at sign example dot com', 'ssh deploy@example.com'],
    ['export name equals value', 'export name=value'],
    ['echo dollar home', 'echo $home'],
    ['ls star dot txt', 'ls *.txt'],
    ['make double ampersand make install', 'make && make install'],
    ['echo hi greater than out dot txt', 'echo hi > out.txt'],
    ['echo open paren a close paren', 'echo (a)'],
    ['echo quote hello world quote', 'echo "hello world"'],
    ['echo single quote a single quote', "echo 'a'"],
    ['ls dash la space dot', 'ls -la .'],
    ['cd projects semicolon ls', 'cd projects; ls'],
    ['cube control get pods', 'kubectl get pods'],
    ['git log enter', 'git log\r'],
  ])('%s → %s', (spoken, command) => {
    expect(postProcessTranscript(spoken)).toBe(command);
  });

  it('does not turn ordinary words into symbols', () => {
    expect(postProcessTranscript('git commit dash m look at this')).toBe('git commit -m look at this');
  });

  it('only corrects single words in command position', () => {
    expect(postProcessTranscript('get status')).toBe('git status');
    expect(postProcessTranscript('git get')).toBe('git get');
  });

  it('normalizes case and whitespace', () => {
    expect(postProcessTranscript('  GIT   PUSH  ')).toBe('git push');
    expect(postProcessTranscript('')).toBe('');
  });
});

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = true;
  interimResults = false;
  lang = '';
  maxAlternatives = 0;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  constructor() {
    FakeRecognition.instances.push(this);
  }
  emit(transcript: string, isFinal: boolean) {
    this.onresult?.({ results: [{ isFinal, 0: { transcript } }] });
  }
}

describe('voice availability', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeRecognition.instances = [];
  });

  it('reports an insecure context before anything else', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    expect(voiceAvailability()).toBe('insecure-context');
    expect(new VoiceService().available).toBe(false);
  });

  it('reports unsupported browsers', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    expect(voiceAvailability()).toBe('unsupported');
  });

  it('drives the recognizer and reports results and state', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const voice = new VoiceService();
    expect(voice.available).toBe(true);
    const recognizer = FakeRecognition.instances[0];
    expect(recognizer.lang).toBe('en-US');
    expect(recognizer.continuous).toBe(false);

    const states: string[] = [];
    const results: Array<[string, boolean]> = [];
    voice.onStateChange((s) => states.push(s));
    voice.onResult((r) => results.push([r.transcript, r.isFinal]));

    voice.toggle();
    expect(recognizer.start).toHaveBeenCalledOnce();
    recognizer.emit('git', false);
    recognizer.emit('git status', true);
    voice.toggle();
    expect(recognizer.stop).toHaveBeenCalledOnce();
    expect(states).toEqual(['listening', 'idle']);
    expect(results).toEqual([['git', false], ['git status', true]]);
  });

  it('returns to idle when recognition errors', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const voice = new VoiceService();
    voice.start();
    FakeRecognition.instances[0].onerror?.();
    expect(voice.state).toBe('idle');
  });
});
