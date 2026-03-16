import { describe, it, expect } from 'vitest';
import { postProcessTranscript } from '../src/services/voice.js';

describe('postProcessTranscript', () => {
  it('should convert symbol words to characters', () => {
    expect(postProcessTranscript('git commit dash m')).toBe('git commit - m');
  });

  it('should handle double dash', () => {
    expect(postProcessTranscript('double dash verbose')).toBe('-- verbose');
  });

  it('should handle pipe', () => {
    expect(postProcessTranscript('ls pipe grep test')).toBe('ls | grep test');
  });

  it('should correct common misrecognitions', () => {
    expect(postProcessTranscript('get status')).toBe('git status');
    expect(postProcessTranscript('pseudo apt install')).toBe('sudo apt install');
    expect(postProcessTranscript('dock her ps')).toBe('docker ps');
  });

  it('should handle tilde and slash', () => {
    expect(postProcessTranscript('cd tilde slash projects')).toBe('cd ~ / projects');
  });

  it('should handle dot', () => {
    expect(postProcessTranscript('ls dash la dot')).toBe('ls - la .');
  });

  it('should lowercase the output', () => {
    expect(postProcessTranscript('GIT PUSH')).toBe('git push');
  });

  it('should trim whitespace', () => {
    expect(postProcessTranscript('  ls  ')).toBe('ls');
  });

  it('should handle ampersand', () => {
    expect(postProcessTranscript('make double ampersand make install')).toBe(
      'make && make install'
    );
  });
});
