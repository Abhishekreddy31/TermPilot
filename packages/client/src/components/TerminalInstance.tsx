import { useEffect, useRef, useImperativeHandle, forwardRef } from 'preact/compat';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { WsClient, WsMessage } from '../services/ws-client.js';

interface TerminalInstanceProps {
  sessionId: string;
  wsClient: WsClient;
}

export const TerminalInstance = forwardRef<
  { sendInput: (data: string) => void; scrollUp: () => void; scrollDown: () => void },
  TerminalInstanceProps
>(({ sessionId, wsClient }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useImperativeHandle(ref, () => ({
    sendInput: (data: string) => {
      wsClient.send({ type: 'input', sessionId, data });
    },
    scrollUp: () => {
      termRef.current?.scrollLines(-5);
    },
    scrollDown: () => {
      termRef.current?.scrollLines(5);
    },
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Menlo', 'Courier New', monospace",
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: '#264f78',
        selectionForeground: '#ffffff',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d2c0',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    requestAnimationFrame(() => {
      fitAddon.fit();
      wsClient.send({
        type: 'resize',
        sessionId,
        cols: term.cols,
        rows: term.rows,
      });
    });

    termRef.current = term;
    fitRef.current = fitAddon;

    const dataDisposable = term.onData((data: string) => {
      wsClient.send({ type: 'input', sessionId, data });
    });

    const msgUnsub = wsClient.onMessage((msg: WsMessage) => {
      if (msg.type === 'output' && msg.sessionId === sessionId) {
        term.write(msg.data as string);
      }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      wsClient.send({ type: 'resize', sessionId, cols, rows });
    });

    let resizeTimeout: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => fitAddon.fit(), 150);
    };

    window.addEventListener('resize', handleResize);
    const vv = window.visualViewport;
    if (vv) vv.addEventListener('resize', handleResize);

    // === Touch scroll via capture phase ===
    // We intercept touch events in the capture phase (before xterm.js sees them).
    // If user swipes vertically, we stopPropagation so xterm.js doesn't interfere,
    // and call term.scrollLines() ourselves.
    const container = containerRef.current;
    let startY = 0;
    let startX = 0;
    let startTime = 0;
    let scrolled = false;
    let lastY = 0;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        startY = e.touches[0].clientY;
        startX = e.touches[0].clientX;
        lastY = startY;
        startTime = Date.now();
        scrolled = false;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;

      const curY = e.touches[0].clientY;
      const curX = e.touches[0].clientX;
      const totalMovedY = Math.abs(startY - curY);
      const totalMovedX = Math.abs(startX - curX);

      if (totalMovedY > 10 && totalMovedY > totalMovedX) {
        scrolled = true;
        // Stop xterm.js from handling this touch
        e.stopPropagation();
        e.preventDefault();

        const delta = lastY - curY;
        lastY = curY;

        // Each 16px of finger movement = 1 line
        const lines = Math.round(delta / 16);
        if (lines !== 0) {
          term.scrollLines(lines);
        }
      }
    };

    const onTouchEnd = () => {
      if (!scrolled && (Date.now() - startTime) < 300) {
        term.focus();
      }
    };

    // capture: true fires BEFORE xterm.js's own handlers
    container.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    container.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    container.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });

    // Also handle tap to focus
    container.addEventListener('click', () => term.focus());

    return () => {
      clearTimeout(resizeTimeout);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      msgUnsub();
      window.removeEventListener('resize', handleResize);
      if (vv) vv.removeEventListener('resize', handleResize);
      container.removeEventListener('touchstart', onTouchStart, { capture: true });
      container.removeEventListener('touchmove', onTouchMove, { capture: true });
      container.removeEventListener('touchend', onTouchEnd, { capture: true });
      term.dispose();
    };
  }, [sessionId, wsClient]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%' }}
    />
  );
});
