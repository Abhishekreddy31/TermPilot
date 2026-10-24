import { describe, expect, it } from 'vitest';
import { parseRegQuery, windowsSessionEnvironment } from '../../../packages/server/src/terminal/windows-env.js';

const SYSTEM = [
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  '    ComSpec    REG_EXPAND_SZ    %SystemRoot%\\system32\\cmd.exe',
  '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;%SystemRoot%',
  '    PSModulePath    REG_EXPAND_SZ    %ProgramFiles%\\WindowsPowerShell\\Modules',
  '    PROCESSOR_IDENTIFIER    REG_SZ    Intel64 Family 6',
  '    TEMP    REG_EXPAND_SZ    %SystemRoot%\\TEMP',
  '    NUMBER_OF_PROCESSORS    REG_SZ    8',
  '    LaterRef    REG_EXPAND_SZ    %DefinedAfter%\\x',
  '    DefinedAfter    REG_SZ    C:\\after',
  '',
].join('\r\n');
const USER = [
  'HKEY_CURRENT_USER\\Environment',
  '    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin',
  '    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
  '    JAVA_HOME    REG_SZ    C:\\Program Files\\Java',
  '    Unresolved    REG_EXPAND_SZ    %NOPE%\\y',
  '',
].join('\r\n');
const VOLATILE = ['HKEY_CURRENT_USER\\Volatile Environment', '    LOGONSERVER    REG_SZ    \\\\DC1', ''].join('\r\n');

const source = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  USERPROFILE: 'C:\\Users\\ada',
  USERNAME: 'ada',
  AWS_SECRET_ACCESS_KEY: 'from the launching shell',
  Path: 'C:\\launching\\shell\\only',
};
const reader = (key: string) => (key.startsWith('HKLM') ? SYSTEM : key === 'HKCU\\Environment' ? USER : key.includes('Volatile') ? VOLATILE : null);

describe('parseRegQuery', () => {
  it('reads string values and ignores headers and other types', () => {
    const values = parseRegQuery('HKEY\\Key\r\n    A    REG_SZ    one\r\n    B    REG_DWORD    0x1\r\n    C    REG_EXPAND_SZ    %A%\r\n');
    expect(values).toEqual([
      { name: 'A', value: 'one', expand: false },
      { name: 'C', value: '%A%', expand: true },
    ]);
  });

  it('keeps spaces inside values', () => {
    expect(parseRegQuery('    JAVA_HOME    REG_SZ    C:\\Program Files\\Java')[0].value).toBe('C:\\Program Files\\Java');
  });
});

describe('windowsSessionEnvironment', () => {
  const env = windowsSessionEnvironment(source, reader)!;

  it('expands system variables against the session', () => {
    expect(env.ComSpec).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(env.PSModulePath).toBe('C:\\Program Files\\WindowsPowerShell\\Modules');
    expect(env.PROCESSOR_IDENTIFIER).toBe('Intel64 Family 6');
  });

  it('appends the user Path to the system Path, as Windows does', () => {
    expect(env.Path).toBe('C:\\Windows\\system32;C:\\Windows;C:\\Users\\ada\\bin');
  });

  it('lets user variables override system ones and adds the user\'s own settings', () => {
    expect(env.TEMP).toBe('C:\\Users\\ada\\AppData\\Local\\Temp');
    expect(env.JAVA_HOME).toBe('C:\\Program Files\\Java');
  });

  it('includes volatile per-logon variables and session-derived ones', () => {
    expect(env.LOGONSERVER).toBe('\\\\DC1');
    expect(env.USERNAME).toBe('ada');
  });

  it('resolves references to values defined later in the same key, and leaves unknown ones', () => {
    expect(env.LaterRef).toBe('C:\\after\\x');
    expect(env.Unresolved).toBe('%NOPE%\\y');
  });

  it('does not carry over anything that exists only in the launching environment', () => {
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(Object.values(env).join(';')).not.toContain('launching');
  });

  it('keeps one spelling per variable (names are case-insensitive)', () => {
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path']);
  });

  it('returns null when the system environment cannot be read', () => {
    expect(windowsSessionEnvironment(source, () => null)).toBeNull();
  });
});
