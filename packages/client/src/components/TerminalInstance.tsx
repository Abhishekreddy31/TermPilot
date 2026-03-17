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
  { sendInput: (data: string) => void },
  TerminalInstanceProps
>(({ sessionId, wsClient }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useImperativeHandle(ref, () => ({
    sendInput: (data: string) => {
      wsClient.send({ type: 'input', sessionId, data });
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
      overviewRuler: {},
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Fit after rendering
    requestAnimationFrame(() => {
      fitAddon.fit();
      // Send initial size to server
      wsClient.send({
        type: 'resize',
        sessionId,
        cols: term.cols,
        rows: term.rows,
      });
    });

    termRef.current = term;
    fitRef.current = fitAddon;

    // User input -> server
    const dataDisposable = term.onData((data: string) => {
      wsClient.send({ type: 'input', sessionId, data });
    });

    // Server output -> terminal
    const msgUnsub = wsClient.onMessage((msg: WsMessage) => {
      if (msg.type === 'output' && msg.sessionId === sessionId) {
        term.write(msg.data as string);
      }
    });

    // Resize handler
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      wsClient.send({ type: 'resize', sessionId, cols, rows });
    });

    // Window/viewport resize
    let resizeTimeout: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        fitAddon.fit();
      }, 150);
    };

    window.addEventListener('resize', handleResize);

    // Visual viewport (mobile keyboard show/hide)
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', handleResize);
    }

    // Mobile touch scrolling: track swipe gestures to scroll terminal
    let touchStartY = 0;
    let touchStartX = 0;
    let isScrolling = false;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
        touchStartX = e.touches[0].clientX;
        isScrolling = false;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;

      const deltaY = touchStartY - e.touches[0].clientY;
      const deltaX = Math.abs(touchStartX - e.touches[0].clientX);

      // If vertical movement is greater than horizontal, it's a scroll
      if (Math.abs(deltaY) > 10 && Math.abs(deltaY) > deltaX) {
        isScrolling = true;
        const lines = Math.round(deltaY / 20);
        if (lines !== 0) {
          term.scrollLines(lines);
          touchStartY = e.touches[0].clientY;
        }
      }
    };

    const handleTouchEnd = () => {
      // Only focus (show keyboard) on tap, not after scrolling
      if (!isScrolling) {
        term.focus();
      }
    };

    const container = containerRef.current;
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      clearTimeout(resizeTimeout);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      msgUnsub();
      window.removeEventListener('resize', handleResize);
      if (vv) vv.removeEventListener('resize', handleResize);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
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
