import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test, IS_WINDOWS } from './fixtures.js';
// TEMPORARY diagnostic, removed before merge.
const SAFE = ['HOME','USER','LOGNAME','SHELL','PATH','TZ','LANG','LANGUAGE','LC_ALL','LC_CTYPE','LC_MESSAGES','LC_COLLATE','LC_NUMERIC','LC_TIME','TERM','COLORTERM','EDITOR','VISUAL','PAGER','TMPDIR','XDG_RUNTIME_DIR','XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','SSH_AUTH_SOCK','TMUX_TMPDIR','SystemRoot','SystemDrive','windir','ComSpec','PATHEXT','OS','USERPROFILE','USERNAME','USERDOMAIN','COMPUTERNAME','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','ProgramData','ProgramFiles','ProgramFiles(x86)','ProgramW6432','CommonProgramFiles','CommonProgramFiles(x86)','PSModulePath','TEMP','TMP','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','WSLENV','WT_SESSION'];
function safeEnv(drop: string[] = []): Record<string, string> {
  const upper = new Map(Object.entries(process.env).map(([k, v]) => [k.toUpperCase(), v]));
  const env: Record<string, string> = {};
  for (const k of SAFE) { const v = upper.get(k.toUpperCase()); if (v && !drop.includes(k)) env[k] = v; }
  env.TERM = 'xterm-256color';
  return env;
}
async function time(label: string, env: Record<string, string>) {
  const require = createRequire(join(process.env.TERMPILOT_E2E_PREFIX!, 'node_modules', 'x.js'));
  const pty = require('node-pty');
  const p = pty.spawn('powershell.exe', [], { cols: 80, rows: 24, cwd: process.env.USERPROFILE, env });
  let out = '';
  p.onData((d: string) => { out += d; });
  const t0 = Date.now();
  while (!/PS .*>/.test(out) && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
  const t1 = Date.now();
  p.write('echo "probe-$(40+2)"\r');
  while (!out.includes('probe-42') && Date.now() - t1 < 90000) await new Promise((r) => setTimeout(r, 50));
  console.log(`PROBE ${label}: prompt ${t1 - t0}ms, first command ${Date.now() - t1}ms${out.includes('probe-42') ? '' : ' (NO OUTPUT)'}`);
  p.kill();
}
test('probe: env', async () => {
  test.skip(!IS_WINDOWS);
  test.setTimeout(600_000);
  const full = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>;
  await time('full env', full);
  await time('safe env', safeEnv());
  await time('full env again', full);
  const missing = Object.keys(full).filter((k) => !Object.keys(safeEnv()).some((s) => s.toUpperCase() === k.toUpperCase()));
  console.log(`PROBE vars dropped by allowlist: ${missing.join(' ')}`);
});
