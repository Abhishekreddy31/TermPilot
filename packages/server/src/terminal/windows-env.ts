import { execFileSync } from 'node:child_process';

/**
 * The environment Windows gives a newly started program in the user's session, as
 * Explorer does: system variables, then the user's variables, then the per-logon
 * volatile ones, with %VAR% references expanded. A shell started this way behaves like
 * one opened from the Start menu, and does not see variables that only exist in the
 * environment TermPilot itself was launched from.
 */

const SYSTEM_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_KEY = 'HKCU\\Environment';
const VOLATILE_KEY = 'HKCU\\Volatile Environment';

/**
 * Variables Windows derives at logon rather than storing under the keys above (profile
 * paths, machine and account names). They describe the session, not secrets.
 */
const SESSION_DERIVED = [
  'ALLUSERSPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'PUBLIC',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'SystemDrive', 'SystemRoot', 'windir', 'COMPUTERNAME',
  'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SESSIONNAME',
];

const VALUE_LINE = /^ {4}(.+?) {4}(REG_SZ|REG_EXPAND_SZ) {4}(.*)$/;

export interface RegistryValue {
  name: string;
  value: string;
  expand: boolean;
}

/** Parse `reg query <key>` output into string values. */
export function parseRegQuery(output: string): RegistryValue[] {
  const values: RegistryValue[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = VALUE_LINE.exec(line);
    if (match) values.push({ name: match[1], value: match[3], expand: match[2] === 'REG_EXPAND_SZ' });
  }
  return values;
}

/** Case-insensitive environment, as on Windows, remembering each name's original spelling. */
class WindowsEnv {
  private readonly entries = new Map<string, { name: string; value: string }>();

  get(name: string): string | undefined {
    return this.entries.get(name.toUpperCase())?.value;
  }

  set(name: string, value: string): void {
    const existing = this.entries.get(name.toUpperCase());
    this.entries.set(name.toUpperCase(), { name: existing?.name ?? name, value });
  }

  expand(value: string): string {
    return value.replace(/%([^%]+)%/g, (whole, name: string) => this.get(name) ?? whole);
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries([...this.entries.values()].map(({ name, value }) => [name, value]));
  }
}

export type RegistryReader = (key: string) => string | null;

function readRegistry(key: string): string | null {
  try {
    return execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null; // The key may legitimately not exist (e.g. no volatile environment).
  }
}

/**
 * Build the session environment, or return null if the system environment cannot be
 * read (callers then fall back to an allowlist).
 */
export function windowsSessionEnvironment(source: NodeJS.ProcessEnv, read: RegistryReader = readRegistry): Record<string, string> | null {
  const system = read(SYSTEM_KEY);
  if (system === null) return null;

  const env = new WindowsEnv();
  const lookup = new Map(Object.entries(source).map(([key, value]) => [key.toUpperCase(), value]));
  for (const name of SESSION_DERIVED) {
    const value = lookup.get(name.toUpperCase());
    if (value) env.set(name, value);
  }

  const apply = (values: RegistryValue[], mergePath: boolean) => {
    const previousPath = env.get('PATH');
    // Set every value of the key first, so references between them resolve in any order.
    for (const { name, value } of values) env.set(name, value);
    for (const { name, value, expand } of values) {
      const resolved = expand ? env.expand(value) : value;
      // Windows appends the user's Path to the system Path instead of replacing it.
      if (mergePath && name.toUpperCase() === 'PATH' && previousPath) env.set(name, `${previousPath};${resolved}`);
      else env.set(name, resolved);
    }
  };
  apply(parseRegQuery(system), false);
  apply(parseRegQuery(read(USER_KEY) ?? ''), true);
  apply(parseRegQuery(read(VOLATILE_KEY) ?? ''), false);
  return env.toRecord();
}
