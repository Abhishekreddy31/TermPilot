import { describe, expect, it } from 'vitest';
import { NO_MODIFIERS, applyModifiers, hasModifiers } from '../../../packages/client/src/services/keys.js';

const ctrl = { ctrl: true, alt: false };
const alt = { ctrl: false, alt: true };
const both = { ctrl: true, alt: true };

describe('applyModifiers', () => {
  it('passes input through when nothing is armed', () => {
    expect(applyModifiers('c', NO_MODIFIERS)).toBe('c');
    expect(hasModifiers(NO_MODIFIERS)).toBe(false);
  });

  it('maps Ctrl+letter to its control code regardless of case', () => {
    expect(applyModifiers('c', ctrl)).toBe('\x03');
    expect(applyModifiers('C', ctrl)).toBe('\x03');
    expect(applyModifiers('a', ctrl)).toBe('\x01');
    expect(applyModifiers('z', ctrl)).toBe('\x1a');
    expect(applyModifiers('d', ctrl)).toBe('\x04');
  });

  it('maps Ctrl+symbol the way xterm does', () => {
    expect(applyModifiers('[', ctrl)).toBe('\x1b');
    expect(applyModifiers('\\', ctrl)).toBe('\x1c');
    expect(applyModifiers(']', ctrl)).toBe('\x1d');
    expect(applyModifiers('/', ctrl)).toBe('\x1f');
    expect(applyModifiers(' ', ctrl)).toBe('\x00');
    expect(applyModifiers('?', ctrl)).toBe('\x7f');
  });

  it('leaves characters without a control code unchanged under Ctrl', () => {
    expect(applyModifiers('|', ctrl)).toBe('|');
    expect(applyModifiers('é', ctrl)).toBe('é');
  });

  it('prefixes ESC for Alt', () => {
    expect(applyModifiers('b', alt)).toBe('\x1bb');
    expect(applyModifiers('.', alt)).toBe('\x1b.');
    expect(applyModifiers('c', both)).toBe('\x1b\x03');
  });

  it('adds the xterm modifier parameter to cursor keys in either encoding', () => {
    expect(applyModifiers('\x1b[A', ctrl)).toBe('\x1b[1;5A');
    expect(applyModifiers('\x1bOD', ctrl)).toBe('\x1b[1;5D');
    expect(applyModifiers('\x1b[C', alt)).toBe('\x1b[1;3C');
    expect(applyModifiers('\x1b[B', both)).toBe('\x1b[1;7B');
  });

  it('adds the modifier parameter to tilde keys', () => {
    expect(applyModifiers('\x1b[5~', ctrl)).toBe('\x1b[5;5~');
    expect(applyModifiers('\x1b[3~', alt)).toBe('\x1b[3;3~');
  });

  it('treats a multi-character string (paste) as text, not a keystroke', () => {
    expect(applyModifiers('hello', ctrl)).toBe('hello');
  });

  it('treats one astral character as a single keystroke', () => {
    expect(applyModifiers('😀', alt)).toBe('\x1b😀');
  });
});
