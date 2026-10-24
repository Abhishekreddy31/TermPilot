import { useEffect, useImperativeHandle, useRef, forwardRef } from 'preact/compat';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ServerMessage, TerminalSize } from '@termpilot/shared';
import type { WsClient } from '../services/ws-client.js';
import { TERMINAL_THEME } from '../styles/terminal-theme.js';

export type { TerminalSize };

export interface TerminalHandle {
  /** The fitted size, or null if the terminal has never been laid out (e.g. a hidden tab). */
  size(): TerminalSize | null;
  scrollPages(pages: number): void;
  focus(): void;
}

interface TerminalInstanceProps {
  sessionId: string;
  wsClient: WsClient;
  visible: boolean;
  /** Keyboard input typed into this terminal. */
  onInput: (data: string) => void;
  onResize: (size: TerminalSize) => void;
  /** Fired once after mounting, with the fitted size, or null if the terminal is not laid out yet. */
  onReady: (size: TerminalSize | null) => void;
}

const SCROLLBACK_LINES = 5000;
const RESIZE_DEBOUNCE_MS = 150;
/** Finger travel, in CSS pixels, that scrolls one line. */
const TOUCH_PIXELS_PER_LINE = 16;
/** Movement below this is a tap, not a scroll. */
const TOUCH_SCROLL_THRESHOLD_PX = 10;
const TAP_MAX_MS = 300;

/**
 * Fit to the container if it has a real layout. Returns whether the terminal now has a real size.
 * A hidden tab's container has no layout, and FitAddon then proposes a tiny bogus size (e.g. 8×5);
 * applying it would resize the shell and make it redraw for a screen that does not exist.
 */
function fitToLayout(term: Terminal, fit: FitAddon, fitted: { current: boolean }): boolean {
  const container = term.element?.parentElement;
  if (!container || container.clientWidth === 0 || container.clientHeight === 0) return fitted.current;
  const dims = fit.proposeDimensions();
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 1 || dims.rows < 1) {
    return fitted.current;
  }
  if (dims.cols !== term.cols || dims.rows !== term.rows) term.resize(dims.cols, dims.rows);
  fitted.current = true;
  return true;
}

/**
 * One xterm.js terminal. It renders output for `sessionId` and reports input and
 * size changes; which session it shows and when to attach is decided by TerminalView.
 */
export const TerminalInstance = forwardRef<TerminalHandle, TerminalInstanceProps>(
  ({ sessionId, wsClient, visible, onInput, onResize, onReady }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    // Whether the terminal has been fitted to real layout at least once. Before that its
    // size is xterm's default, which must never be reported: resizing the shell to a size
    // the screen does not have makes it redraw with wrong cursor movement.
    const fitted = useRef(false);
    // True while replayed output is parsed. Replayed output can contain queries (device
    // attributes, cursor position) that were already answered when they first ran; answering
    // them again would type stale replies into the program, so replies are dropped meanwhile.
    const replaying = useRef(false);
    // Latest callbacks, so the long-lived terminal listeners never call stale props.
    const callbacks = useRef({ onInput, onResize, onReady });
    callbacks.current = { onInput, onResize, onReady };

    useImperativeHandle(ref, () => ({
      size: () => (fitted.current && termRef.current ? { cols: termRef.current.cols, rows: termRef.current.rows } : null),
      scrollPages: (pages) => termRef.current?.scrollPages(pages),
      focus: () => termRef.current?.focus(),
    }), []);

    // Create the terminal once per mounted tab.
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', Menlo, Monaco, 'Cascadia Code', 'Courier New', monospace",
        theme: TERMINAL_THEME,
        scrollback: SCROLLBACK_LINES,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      termRef.current = term;
      fitRef.current = fit;

      const fitSafely = () => fitToLayout(term, fit, fitted);

      // Layout is only final after the next frame.
      const readyFrame = requestAnimationFrame(() => {
        callbacks.current.onReady(fitSafely() ? { cols: term.cols, rows: term.rows } : null);
      });

      const disposables = [
        term.onData((data) => {
          if (!replaying.current) callbacks.current.onInput(data);
        }),
        term.onResize(({ cols, rows }) => {
          // Sizing for a replay is local; only the size after it is the client's real size.
          if (!replaying.current) callbacks.current.onResize({ cols, rows });
        }),
      ];

      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleFit = () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(fitSafely, RESIZE_DEBOUNCE_MS);
      };
      const observer = new ResizeObserver(scheduleFit);
      observer.observe(container);
      const viewport = globalThis.visualViewport;
      viewport?.addEventListener('resize', scheduleFit);

      // Vertical swipes scroll the scrollback. Handled in the capture phase so
      // xterm.js does not also treat the gesture as a selection.
      let startX = 0;
      let startY = 0;
      let lastY = 0;
      let startTime = 0;
      let scrolling = false;
      const onTouchStart = (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = lastY = e.touches[0].clientY;
        startTime = Date.now();
        scrolling = false;
      };
      const onTouchMove = (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        const { clientX, clientY } = e.touches[0];
        const dy = Math.abs(startY - clientY);
        if (dy <= TOUCH_SCROLL_THRESHOLD_PX || dy <= Math.abs(startX - clientX)) return;
        scrolling = true;
        e.stopPropagation();
        e.preventDefault();
        const lines = Math.trunc((lastY - clientY) / TOUCH_PIXELS_PER_LINE);
        if (lines !== 0) {
          term.scrollLines(lines);
          lastY -= lines * TOUCH_PIXELS_PER_LINE;
        }
      };
      const onTouchEnd = () => {
        if (!scrolling && Date.now() - startTime < TAP_MAX_MS) term.focus();
      };
      container.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
      container.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
      container.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });

      return () => {
        cancelAnimationFrame(readyFrame);
        clearTimeout(resizeTimer);
        observer.disconnect();
        viewport?.removeEventListener('resize', scheduleFit);
        container.removeEventListener('touchstart', onTouchStart, { capture: true });
        container.removeEventListener('touchmove', onTouchMove, { capture: true });
        container.removeEventListener('touchend', onTouchEnd, { capture: true });
        for (const disposable of disposables) disposable.dispose();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }, []);

    // Render output for the session this tab currently shows.
    useEffect(() => {
      return wsClient.onMessage((message: ServerMessage) => {
        const term = termRef.current;
        if (!term) return;
        if (message.type === 'output' && message.sessionId === sessionId) {
          term.write(message.data);
        } else if (message.type === 'session_attached' && message.sessionId === sessionId) {
          // The replay is the session's recent output: redraw it from a clean screen at the
          // size it was produced at, then fit to this screen (the program redraws for it).
          replaying.current = true;
          term.reset();
          term.resize(message.cols, message.rows);
          term.write(message.replay, () => {
            replaying.current = false;
            // A hidden tab is fitted when it becomes visible.
            if (fitRef.current) fitToLayout(term, fitRef.current, fitted);
          });
        }
      });
    }, [sessionId, wsClient]);

    useEffect(() => {
      if (!visible) return;
      const frame = requestAnimationFrame(() => {
        const term = termRef.current;
        if (term && fitRef.current) fitToLayout(term, fitRef.current, fitted);
        term?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }, [visible]);

    return <div ref={containerRef} class="terminal-instance" data-session-id={sessionId} />;
  },
);
