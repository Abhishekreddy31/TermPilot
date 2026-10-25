# Changelog

## 1.1.1

- README: a demo, a short security overview, a comparison with similar tools, and a private network such as
  Tailscale as the recommended way to reach TermPilot day to day. No code changes.

## 1.1.0

### Changes that may affect you

- `--tunnel` no longer also exposes the server to the local network. cloudflared connects over loopback, so the
  server keeps listening on `127.0.0.1`. Use `--host 0.0.0.0` if you also want LAN access.
- Unknown command-line options and invalid ports are now errors (exit code 2) instead of being ignored.
- Requests are only accepted for this machine's own hostnames and addresses, the tunnel hostname, and
  `--allowed-hosts`. If you reach TermPilot through your own domain or proxy, add it with `--allowed-hosts`.

### New

- Shells survive disconnects and page reloads: they belong to your login, and reconnecting gives them back with
  their recent output. Mirror tabs re-attach to their tmux session after a reconnect.
- Ctrl and Alt on the extra-keys bar now apply to the next key typed on the phone keyboard, so Ctrl+C, Ctrl+D and
  friends work. Ctrl/Alt with arrow and paging keys send the standard xterm sequences.
- `--allowed-hosts` / `TERMPILOT_ALLOWED_HOSTS` for custom hostnames.
- Server errors (such as the session limit) are shown in the UI, with a "Retry now" button while disconnected; the
  page also reconnects immediately when the phone wakes up or regains network.
- Linux x64/arm64 installs no longer need a C++ toolchain (prebuilt terminal binaries).

### Fixed

- Voice commands produced wrong commands: "git commit dash m hello" gave `git commit - m hello` and
  "cd tilde slash projects" gave `cd ~ / projects`. Symbols now join correctly, and ordinary words such as "at" are
  no longer turned into symbols.
- Quiet long-running commands were killed after 5 minutes without output.
- Shells were killed whenever the connection dropped.
- tmux session names matched by prefix (attaching "dev" could open "devops").
- Tab close buttons were invisible on touch screens.
- A flood of output (e.g. `cat` on a large file) over a slow link could grow server memory without bound; output is
  now paused until the phone catches up.
- Replayed output no longer makes the terminal re-answer old queries (which typed stray text into tmux and vim).
- The tunnel could fail where `localhost` resolves to `::1`.
- On Windows, shells now get the user's session environment (from the registry, as a terminal opened from the
  Start menu does): previously PowerShell stalled for about 35 seconds on its first command and user variables
  such as `JAVA_HOME` were missing. `HOME` is no longer assumed (credentials went to `\tmp`), and `$SHELL` from
  Git Bash is no longer used. On Linux the default shell falls back to the account's shell instead of `/bin/zsh`.
- tmux listing and attaching now use the same `TMUX_TMPDIR`; `SSH_AUTH_SOCK` is passed to shells so SSH-based git
  works.
- Pressing Enter from voice input sends a carriage return, like a keyboard.
- Ctrl+C during startup now shuts down cleanly.

### Security

- Host and Origin checks on HTTP and WebSocket requests (DNS-rebinding protection).
- Rate limiting identifies tunnel clients by their real address.
- Stricter Content Security Policy and additional security headers; CORS removed (the app is same-origin only).
- Login expiry now disconnects open connections and ends the user's shells when no valid login remains.
- Dependencies updated; `pnpm audit` reports no known vulnerabilities (previously 72, including high-severity
  issues in the runtime dependencies `ws` and `zod`).

### Internal

- Typed protocol shared by client and server, validated with Zod 4 on the server; the browser bundle no longer
  includes Zod.
- Tests reorganised under `tests/` (unit, integration, e2e); end-to-end tests install the packed npm package and
  drive it in mobile Chrome and Safari. CI runs on Linux, macOS and Windows across Node 20–26, and releases are
  published from CI with npm provenance.
