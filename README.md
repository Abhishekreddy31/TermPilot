# TermPilot

**Mobile-first PWA for managing multiple terminal sessions remotely with voice control.**

TermPilot lets developers manage terminal windows on their laptop from their phone — with voice commands, multi-session tabs, and remote access from anywhere. Built from scratch, completely free, no paid services required.

---

## Features

- **Multi-terminal management** — Create, destroy, and switch between terminal sessions from your phone
- **Voice commands** — Transcribe voice to terminal commands via Web Speech API with smart post-processing for developer vocabulary
- **Remote access** — Access your terminals from anywhere via Cloudflare Tunnel (free), not just your local network
- **Mobile-optimized UI** — Extra keys row (Esc, Tab, Ctrl, arrows), safe area support for notch/home indicator, responsive design
- **PWA installable** — Add to home screen for a native app-like experience, works offline (app shell cached)
- **Secure** — Password authentication with scrypt hashing, server-side sessions, rate limiting, session timeouts

---

## Architecture

```mermaid
graph TB
    subgraph Phone["Phone (Any Browser)"]
        PWA["PWA Client<br/>Preact + xterm.js"]
        Voice["Voice Input<br/>Web Speech API"]
        ExtraKeys["Extra Keys Row<br/>Esc, Tab, Ctrl, Arrows"]
    end

    subgraph Network["Network Layer"]
        CF["Cloudflare Tunnel<br/>(optional, free)"]
    end

    subgraph Laptop["Your Laptop"]
        HTTP["HTTP Server<br/>Auth + Static Files"]
        WS["WebSocket Server<br/>JSON Protocol"]
        PTY["PTY Manager<br/>node-pty"]
        Auth["Auth Service<br/>scrypt + sessions"]
        Shell1["Shell 1<br/>/bin/zsh"]
        Shell2["Shell 2<br/>/bin/bash"]
        ShellN["Shell N<br/>..."]
    end

    PWA <-->|"WSS (encrypted)"| CF
    Voice -->|"transcript"| PWA
    ExtraKeys -->|"key data"| PWA
    CF <-->|"localhost"| WS
    PWA <-->|"HTTPS"| CF
    CF <-->|"localhost"| HTTP
    HTTP --> Auth
    WS --> PTY
    WS --> Auth
    PTY --> Shell1
    PTY --> Shell2
    PTY --> ShellN

    style Phone fill:#1e1e1e,stroke:#007acc,color:#d4d4d4
    style Laptop fill:#252526,stroke:#007acc,color:#d4d4d4
    style Network fill:#2d2d2d,stroke:#555,color:#d4d4d4
```

---

## User Flow

```mermaid
flowchart TD
    A[Open TermPilot in browser] --> B{Authenticated?}
    B -->|No| C[Login Screen]
    C --> D[Enter username + password]
    D --> E[Server validates credentials]
    E -->|Invalid| F[Show error, rate limit]
    F --> D
    E -->|Valid| G[Store session token]
    B -->|Yes| G
    G --> H[WebSocket connects to server]
    H --> I[Auto-create first terminal session]
    I --> J[Terminal ready - show shell prompt]

    J --> K{User Action}
    K -->|Type on keyboard| L[Send keystrokes via WebSocket]
    K -->|Tap extra keys| M[Send control characters]
    K -->|Tap Voice button| N[Start speech recognition]
    K -->|Tap + tab| O[Create new terminal session]
    K -->|Tap x on tab| P[Destroy terminal session]

    N --> Q[Show interim transcript]
    Q --> R[Show final transcript]
    R --> S{User confirms?}
    S -->|Send| T[Post-process & send as command]
    S -->|Clear| J

    L --> U[Server writes to PTY]
    M --> U
    T --> U
    U --> V[PTY output sent back via WebSocket]
    V --> W[xterm.js renders output]
    W --> J

    O --> X[Server spawns new PTY]
    X --> J
    P --> Y[Server kills PTY process]
    Y --> J

    style A fill:#007acc,color:#fff
    style J fill:#4ec9b0,color:#1e1e1e
    style N fill:#cc3333,color:#fff
```

---

## WebSocket Protocol

```mermaid
sequenceDiagram
    participant C as Client (PWA)
    participant S as Server

    C->>S: HTTP POST /api/auth/login {username, password}
    S-->>C: {token: "abc123"}

    C->>S: WebSocket /ws?token=abc123
    S-->>C: Connection established

    C->>S: {type: "create", cols: 80, rows: 24}
    S-->>C: {type: "session_created", sessionId: "uuid-1"}
    S-->>C: {type: "output", sessionId: "uuid-1", data: "$ "}

    C->>S: {type: "input", sessionId: "uuid-1", data: "ls\n"}
    S-->>C: {type: "output", sessionId: "uuid-1", data: "ls\nfile1 file2\n$ "}

    C->>S: {type: "resize", sessionId: "uuid-1", cols: 120, rows: 40}

    C->>S: {type: "list"}
    S-->>C: {type: "session_list", sessions: [...]}

    C->>S: {type: "destroy", sessionId: "uuid-1"}
    S-->>C: {type: "session_destroyed", sessionId: "uuid-1"}
```

---

## Project Structure

```mermaid
graph LR
    subgraph Monorepo["pnpm Monorepo"]
        Shared["@termpilot/shared<br/>Protocol types<br/>Zod schemas<br/>Encode/decode"]
        Server["@termpilot/server<br/>PTY Manager<br/>WebSocket Server<br/>Auth Service<br/>Tunnel Manager"]
        Client["@termpilot/client<br/>Preact PWA<br/>xterm.js Terminal<br/>Voice Input<br/>Extra Keys"]
        E2E["@termpilot/e2e<br/>Playwright tests"]
    end

    Shared --> Server
    Shared --> Client
    Server --> E2E
    Client --> E2E

    style Shared fill:#569cd6,color:#fff
    style Server fill:#4ec9b0,color:#1e1e1e
    style Client fill:#dcdcaa,color:#1e1e1e
    style E2E fill:#c586c0,color:#fff
```

```
termpilot/
├── package.json                    # Root workspace config
├── pnpm-workspace.yaml
├── tsconfig.base.json              # Shared TypeScript settings
├── vitest.workspace.ts
├── packages/
│   ├── shared/                     # @termpilot/shared
│   │   ├── src/
│   │   │   ├── protocol.ts         # Message types & encode/decode
│   │   │   ├── schemas.ts          # Zod validation schemas
│   │   │   └── index.ts            # Public API
│   │   └── test/
│   │       ├── protocol.test.ts    # 12 tests
│   │       └── schemas.test.ts     # 12 tests
│   ├── server/                     # @termpilot/server
│   │   ├── src/
│   │   │   ├── app.ts              # HTTP + WebSocket server
│   │   │   ├── index.ts            # Entry point + CLI
│   │   │   ├── terminal/
│   │   │   │   └── pty-manager.ts  # PTY lifecycle management
│   │   │   ├── auth/
│   │   │   │   └── auth-service.ts # Auth + rate limiting
│   │   │   └── tunnel/
│   │   │       └── tunnel-manager.ts # Cloudflare Tunnel
│   │   └── test/
│   │       ├── unit/               # 38 unit tests
│   │       └── integration/        # 14 integration tests
│   ├── client/                     # @termpilot/client
│   │   ├── index.html              # PWA shell
│   │   ├── vite.config.ts          # Vite + PWA plugin
│   │   ├── src/
│   │   │   ├── main.tsx            # Entry point
│   │   │   ├── components/
│   │   │   │   ├── App.tsx         # Root component
│   │   │   │   ├── Login.tsx       # Auth screen
│   │   │   │   ├── TerminalView.tsx # Session tabs + terminal
│   │   │   │   ├── TerminalInstance.tsx # xterm.js wrapper
│   │   │   │   ├── ExtraKeys.tsx   # Mobile key toolbar
│   │   │   │   └── VoiceInput.tsx  # Voice recognition UI
│   │   │   ├── services/
│   │   │   │   ├── api.ts          # Auth API client
│   │   │   │   ├── ws-client.ts    # WebSocket with reconnection
│   │   │   │   └── voice.ts        # Speech recognition + post-processing
│   │   │   └── styles/
│   │   │       └── global.css      # Mobile-first styles
│   │   └── test/
│   │       └── voice.test.ts       # 9 tests
│   └── e2e/                        # @termpilot/e2e (Playwright)
│       └── tests/
```

---

## Voice Command Processing

```mermaid
flowchart LR
    A["User speaks:<br/>'get commit dash m hello'"] --> B["Web Speech API<br/>raw transcript"]
    B --> C["Post-processor"]

    subgraph C["Post-Processing Pipeline"]
        D["Symbol mapping<br/>dash → -<br/>pipe → |<br/>tilde → ~"] --> E["Command correction<br/>get → git<br/>pseudo → sudo<br/>dock her → docker"]
    end

    C --> F["Processed:<br/>'git commit - m hello'"]
    F --> G{User confirms?}
    G -->|Send| H["Sent to terminal"]
    G -->|Clear| I["Discarded"]
```

### Supported Voice Symbols

| Spoken | Output | Spoken | Output |
|--------|--------|--------|--------|
| dash / hyphen | `-` | pipe | `\|` |
| double dash | `--` | ampersand | `&` |
| dot / period | `.` | double ampersand | `&&` |
| slash | `/` | at / at sign | `@` |
| backslash | `\` | hash / pound | `#` |
| tilde | `~` | dollar / dollar sign | `$` |
| star / asterisk | `*` | equals / equal sign | `=` |
| colon | `:` | semicolon | `;` |
| quote | `"` | single quote / tick | `'` |
| backtick | `` ` `` | open/close bracket | `[ ]` |
| open/close brace | `{ }` | open/close paren | `( )` |
| greater than | `>` | less than | `<` |

---

## Security Model

```mermaid
flowchart TB
    subgraph Auth["Authentication Layer"]
        Login["POST /api/auth/login"] --> Rate["Rate Limiter<br/>5 attempts / 15 min"]
        Rate -->|Allowed| Verify["Verify password<br/>scrypt (N=16384)"]
        Rate -->|Blocked| Reject["429 Too Many Requests"]
        Verify -->|Valid| Token["Generate session token<br/>256-bit random"]
        Verify -->|Invalid| Deny["401 Unauthorized"]
    end

    subgraph Session["Session Management"]
        Token --> Store["Server-side session store"]
        Store --> Idle["Idle timeout: 30 min"]
        Store --> Absolute["Absolute timeout: 8 hours"]
    end

    subgraph WS["WebSocket Security"]
        Connect["WS /ws?token=xxx"] --> ValidateToken["Validate token<br/>on HTTP upgrade"]
        ValidateToken -->|Valid| Accept["Accept connection"]
        ValidateToken -->|Invalid| Close["Reject (401)"]
        Accept --> Ping["Ping/pong keepalive<br/>every 30s"]
    end

    style Auth fill:#cc3333,color:#fff
    style Session fill:#dcdcaa,color:#1e1e1e
    style WS fill:#569cd6,color:#fff
```

---

## Getting Started

### Prerequisites

- **Node.js** >= 20.0.0
- **pnpm** >= 9.0.0
- **cloudflared** (optional, for remote access) — `brew install cloudflared`

### Installation

```bash
git clone https://github.com/Abhishekreddy31/TermPilot.git
cd TermPilot
pnpm install
```

### Quick Start

```bash
# Build and start (prints login credentials to console)
pnpm start
```

Open `http://localhost:3000` on your phone (same Wi-Fi) or desktop browser.

### With Remote Access

```bash
# Start with Cloudflare Tunnel for access from anywhere
pnpm start -- --tunnel
```

The tunnel URL will be printed to the console. Open it on any device, anywhere.

### Custom Password

```bash
TERMPILOT_PASSWORD=mysecretpassword pnpm start
```

### Development

```bash
# Run server and client dev servers in parallel
pnpm dev

# Server only (with hot reload)
pnpm dev:server

# Client only (Vite dev server with HMR)
pnpm dev:client
```

---

## Testing

```bash
# Run all tests (85 tests across 3 packages)
pnpm test

# Watch mode
pnpm test:watch

# With coverage
pnpm test:coverage
```

### Test Breakdown

| Package | Tests | Type |
|---------|-------|------|
| `@termpilot/shared` | 24 | Protocol encode/decode, schema validation |
| `@termpilot/server` | 52 | PTY lifecycle, auth, rate limiting, WebSocket integration |
| `@termpilot/client` | 9 | Voice post-processing, symbol mapping |
| **Total** | **85** | |

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Monorepo | pnpm workspaces | Strict dependency isolation, fast installs |
| Server runtime | Node.js + TypeScript | Native PTY support via node-pty |
| Terminal backend | node-pty | Same library powering VS Code's terminal |
| WebSocket | ws | Fastest pure-JS WebSocket for Node.js |
| Client framework | Preact | 3KB React alternative, minimal bundle |
| Terminal frontend | xterm.js | Industry-standard terminal emulator |
| Build tool | Vite | Fast builds, PWA plugin, HMR |
| PWA | vite-plugin-pwa + Workbox | Service worker, app shell caching |
| Voice | Web Speech API | Free, built into browsers, no API keys |
| Remote access | Cloudflare Tunnel | Free, automatic TLS, no port forwarding |
| Auth | scrypt (Node.js crypto) | Zero dependencies, constant-time comparison |
| Testing | Vitest | Fast, ESM-native, Jest-compatible API |
| Validation | Zod | Runtime type safety for WebSocket messages |

---

## How It Works

1. **Server starts** on your laptop, spawning an HTTP + WebSocket server
2. **You log in** from your phone's browser with the credentials shown in the console
3. **A terminal session** is created — the server spawns a PTY (pseudo-terminal) running your shell
4. **Everything you type** (keyboard, extra keys, or voice) is sent over WebSocket to the server, which writes it to the PTY
5. **PTY output** (command results, prompts) flows back over WebSocket to xterm.js in your browser
6. **Multiple sessions** can run simultaneously, managed via tabs
7. **If you enable the tunnel**, Cloudflare proxies traffic so you can access your terminals from anywhere, encrypted

### Cost: $0

- No cloud servers — your laptop is the server
- No paid APIs — voice uses the browser's built-in engine
- No app store fees — it's a PWA, runs in any browser
- No paid tunneling — Cloudflare Tunnel free tier, unlimited

---

## License

MIT
