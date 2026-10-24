// Stands in for `cloudflared tunnel --url <target>` in tests.
// FAKE_CLOUDFLARED_MODE:
//   "url"   prints a quick-tunnel URL on stderr (as cloudflared does) and stays up
//   "crash" exits with code 3
//   "echo"  encodes the --url target into the printed hostname, so tests can see where it pointed
const mode = process.env.FAKE_CLOUDFLARED_MODE ?? 'url';

if (mode === 'crash') process.exit(3);

const target = process.argv[process.argv.indexOf('--url') + 1] ?? '';
const label = mode === 'echo' ? target.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase() : 'fake-tunnel-123';

process.stderr.write('INF Requesting new quick Tunnel on trycloudflare.com...\n');
setTimeout(() => process.stderr.write(`INF |  https://${label}.trycloudflare.com  |\n`), 20);
setInterval(() => {}, 1000);
