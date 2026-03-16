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
      fontFamily: "'Menlo', 'Courier New', monospace",
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
      },
      scrollback: 2000,
      allowProposedApi: true,
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

    // Focus terminal on touch
    const handleTouch = () => term.focus();
    containerRef.current.addEventListener('touchstart', handleTouch, {
      passive: true,
    });

    return () => {
      clearTimeout(resizeTimeout);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      msgUnsub();
      window.removeEventListener('resize', handleResize);
      if (vv) vv.removeEventListener('resize', handleResize);
      containerRef.current?.removeEventListener('touchstart', handleTouch);
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
