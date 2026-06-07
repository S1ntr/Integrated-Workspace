import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface TerminalPanelProps {
  id: number;
  sessionId: string;
  label: string;
  command: string;
  workspaceDir: string;
  widthPercent: number;
  fullscreened?: boolean;
  onClose: (id: number) => void;
  onChangeAgent: (id: number, label: string, command: string) => void;
  onToggleFullscreen?: (id: number) => void;
  onSwapSessions?: (idA: number, idB: number) => void;
  onStatusChange?: (id: number, status: "booting" | "running" | "exited") => void;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  id,
  sessionId,
  label,
  command,
  workspaceDir,
  fullscreened = false,
  onClose,
  onChangeAgent,
  onToggleFullscreen,
  onSwapSessions,
  onStatusChange,
}) => {
  const containerRef   = useRef<HTMLDivElement>(null);
  const termRef        = useRef<Terminal | null>(null);
  const fitRef         = useRef<FitAddon | null>(null);
  const rafRef         = useRef<number>(0);
  const ptyReady       = useRef(false);
  const destroyed      = useRef(false);
  const lastSentSize   = useRef({ rows: 0, cols: 0 });

  const [status, setStatus] = useState<"booting" | "running" | "exited">("booting");

  const updateStatus = (newStatus: "booting" | "running" | "exited") => {
    setStatus(newStatus);
    onStatusChange?.(id, newStatus);
  };

  // Refit xterm when fullscreen state changes (CSS transition needs to settle first)
  useEffect(() => {
    const t = window.setTimeout(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    }, 80);
    return () => window.clearTimeout(t);
  }, [fullscreened]);

  // Escape key exits fullscreen
  useEffect(() => {
    if (!fullscreened) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggleFullscreen?.(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreened, id, onToggleFullscreen]);

  useEffect(() => {
    updateStatus("booting");
    const el = containerRef.current;
    if (!el) return;

    destroyed.current = false;
    ptyReady.current  = false;
    const isWindows = navigator.userAgent.includes("Windows");

    // ── 1. Create Terminal ────────────────────────────────────────────────────
    // Uses canvas renderer by default (no WebGL addon loaded — avoids texture atlas bugs in WebView2)
    const term = new Terminal({
      theme: {
        background:          "#080808",
        foreground:          "#d4d4d4",
        cursor:              "#ffffff",
        cursorAccent:        "#080808",
        selectionBackground: "rgba(255,255,255,0.12)",
        black:               "#080808",   brightBlack:   "#333333",
        red:                 "#f87171",   brightRed:     "#fca5a5",
        green:               "#4ade80",   brightGreen:   "#86efac",
        yellow:              "#fbbf24",   brightYellow:  "#fde68a",
        blue:                "#93c5fd",   brightBlue:    "#bfdbfe",
        magenta:             "#c4b5fd",   brightMagenta: "#ddd6fe",
        cyan:                "#67e8f9",   brightCyan:    "#a5f3fc",
        white:               "#d4d4d4",   brightWhite:   "#f0f0f0",
      },
      // IMPORTANT: no cols/rows — FitAddon computes them from container
      // System fonts first: Cascadia Code and Consolas are always available on
      // Windows with no CDN round-trip. IBM Plex Mono loads from Google Fonts
      // CDN asynchronously — if it's first, FitAddon measures with the fallback
      // font on first paint (~7.2px vs 7.8px), computes wrong cols, and the PTY
      // is spawned with wrong dimensions causing text to overflow xterm's width.
      fontFamily:        "'Consolas', 'Cascadia Mono', 'Courier New', monospace",
      fontSize:          13,
      lineHeight:        1.2,
      letterSpacing:     0,
      cursorBlink:       true,
      cursorStyle:       "block",
      scrollback:        2000,
      // The app uses a 3px custom xterm scrollbar. FitAddon otherwise assumes
      // the default 14px gutter and under-counts columns in narrow panes.
      overviewRuler:     { width: 3 },
      // Keep xterm's buffer behavior aligned with Windows ConPTY. This avoids
      // wrapped-line reflow heuristics that can leave stale text after resizes.
      windowsPty:        isWindows ? { backend: "conpty" } : undefined,
      allowTransparency: false,
      // PTY output already carries the terminal's intended CR/LF behavior.
      // For TUI apps, converting LF to CRLF in the renderer can move the cursor
      // differently than a real terminal and create apparent indentation.
      convertEol:        false,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);

    termRef.current = term;
    fitRef.current  = fit;

    // ── 2. Fit helpers ───────────────────────────────────────────────────────
    //
    // fitSync — pure dimension sync, NO canvas refresh.
    // Used in the init stability loop and scheduleForceResize because calling
    // term.refresh() there triggers a canvas repaint that can cause a CSS
    // reflow, which changes clientWidth, which destabilises col measurement,
    // which makes xterm and ConPTY disagree on line width → text corruption.
    const fitSync = () => {
      try { fit.fit(); } catch {}
    };

    const readSafeTerminalSize = () => ({
      rows: Math.max(10, term.rows > 0 ? term.rows : 24),
      cols: Math.max(40, term.cols > 0 ? term.cols : 80),
    });

    const sendPtyResize = (rows: number, cols: number) => {
      if (destroyed.current || !ptyReady.current) return;
      if (rows === lastSentSize.current.rows && cols === lastSentSize.current.cols) return;
      lastSentSize.current = { rows, cols };
      invoke("pty_resize", { sessionId, rows, cols }).catch(() => {});
    };

    // scheduleRefresh — deferred canvas repaint.
    // fit.fit() resizes xterm's internal buffer immediately, but the canvas
    // DOM element resize is applied asynchronously by xterm's renderer.
    // Refreshing synchronously after fit.fit() redraws to a stale canvas.
    // Using a second RAF ensures the canvas has actually been resized first.
    const scheduleRefresh = () => {
      requestAnimationFrame(() => {
        if (!destroyed.current) {
          try { term.refresh(0, term.rows - 1); } catch {}
        }
      });
    };

    // doFit — RAF-debounced fit + deferred refresh.
    // Used by ResizeObserver and drag handlers.
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const schedulePtyResize = (delay = 160, refit = true) => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (destroyed.current || !ptyReady.current) return;
        if (refit) fitSync();
        const { rows, cols } = readSafeTerminalSize();
        sendPtyResize(rows, cols);
      }, delay);
    };
    const doFit = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        if (destroyed.current) return;
        try {
          fit.fit();
          // Defer the canvas refresh so xterm's canvas has time to resize
          // before we force a repaint — prevents black bars in WebView2.
          scheduleRefresh();
          if (ptyReady.current) {
            schedulePtyResize(200, false);
          }
        } catch {}
      });
    };

    let active = true;
    let cleanupData: (() => void) | null = null;
    let cleanupExit: (() => void) | null = null;

    // ── 3. Full terminal initialization ────────────────────────────────────
    const initTerminal = async () => {

      // ─ 3a. Wait until the container has stable, non-zero pixel dimensions. ──
      // Require 8 consecutive frames of identical size before we trust the
      // layout has settled. Flexbox/CSS transitions can take several frames to
      // finish, and measuring too early gives wrong cols → col mismatch with
      // ConPTY → spurious SIGWINCH after startup → text corruption.
      await new Promise<void>(resolve => {
        let lastWidth = -1;
        let lastHeight = -1;
        let stableFrames = 0;
        const REQUIRED_STABLE_FRAMES = 8;
        const poll = () => {
          const container = containerRef.current;
          if (!container || destroyed.current) { resolve(); return; }
          const w = container.clientWidth;
          const h = container.clientHeight;
          if (w >= 100 && h >= 50 && w === lastWidth && h === lastHeight) {
            stableFrames++;
            if (stableFrames >= REQUIRED_STABLE_FRAMES) { resolve(); return; }
          } else {
            stableFrames = 0;
            lastWidth = w;
            lastHeight = h;
          }
          requestAnimationFrame(poll);
        };
        poll();
      });

      if (destroyed.current || !containerRef.current) return;

      // ─ 3b. Open xterm, then wait for FitAddon cols to stabilize. ──────────
      // Wait for all fonts to be ready so char-width measurement is accurate.
      await document.fonts.ready;
      if (destroyed.current) return;

      // We use only system fonts (Cascadia Code / Consolas) so char width is
      // known immediately. This loop runs fitSync each frame until term.cols
      // stays the same for 3 consecutive frames — belt-and-suspenders guard
      // against any late layout passes that could change the container width.
      term.open(el);
      {
        let prevCols = -1;
        let stable = 0;
        for (let i = 0; i < 10 && stable < 3; i++) {
          fitSync();
          await new Promise<void>(r => requestAnimationFrame(() => r()));
          if (destroyed.current) return;
          if (term.cols === prevCols) { stable++; } else { prevCols = term.cols; stable = 0; }
        }
      }

      // ── 4. PTY events ─────────────────────────────────────────────────────
      listen<string>(`pty-data-${sessionId}`, (e) => {
        if (active && !destroyed.current) term.write(e.payload);
      }).then(fn => {
        if (active) {
          cleanupData = fn;
        } else {
          fn();
        }
      });

      listen(`pty-exit-${sessionId}`, () => {
        if (active && !destroyed.current) {
          updateStatus("exited");
          term.writeln("\r\n\x1b[38;2;82;82;91m── process exited ──\x1b[0m");
        }
      }).then(fn => {
        if (active) {
          cleanupExit = fn;
        } else {
          fn();
        }
      });

      // ── 5. Keyboard → PTY ─────────────────────────────────────────────────
      term.onData((data) => {
        if (!ptyReady.current || destroyed.current) return;
        invoke("pty_write", { sessionId, data }).catch(() => {});
      });

      // ── 5a. Self-Healing Focus Observer ───────────────────────────────────
      // Forces a synchronous fit and PTY resize whenever the terminal is focused.
      // This acts as a self-healing mechanism if layout shifts or shell initialization
      // somehow leaves the PTY out of sync with xterm.js.
      const handleFocus = () => {
        if (destroyed.current || !ptyReady.current) return;
        fitSync();
        const { rows, cols } = readSafeTerminalSize();
        sendPtyResize(rows, cols);
      };
      term.textarea?.addEventListener("focus", handleFocus);
      cleanupFns.push(() => term.textarea?.removeEventListener("focus", handleFocus));

      // Also mirror any xterm-side resize caused by direct FitAddon calls
      // (drag-end refreshes, layout restoration, or future callers).
      const resizeDisposable = term.onResize(() => schedulePtyResize(160, false));
      cleanupFns.push(() => resizeDisposable.dispose());

      // ── 5b. ResizeObserver — refit whenever container changes size ────────
      const ro = new ResizeObserver(doFit);
      ro.observe(el);
      cleanupFns.push(() => ro.disconnect());

      // ── 6. Spawn PTY ──────────────────────────────────────────────────────
      // One final fit to lock in the definitive cols/rows.
      fitSync();

      // Enforce a safe minimum size of 40 cols and 10 rows when launching ConPTY
      const { rows, cols } = readSafeTerminalSize();

      lastSentSize.current = { rows, cols };
      invoke("pty_create", { sessionId, command, cwd: workspaceDir, rows, cols })
        .then(() => {
          if (!destroyed.current) {
            ptyReady.current = true;

            // ── 6a. Conditional correction resize after PTY starts ────────────
            // On Windows, cmd.exe can briefly reset the ConPTY console buffer
            // size before the TUI takes over. We check at 700ms and 1800ms
            // whether cols have genuinely changed and send a correction only
            // then.
            //
            // CRITICAL: Do NOT send resize unconditionally. Every pty_resize
            // call sends SIGWINCH to the running process (e.g. opencode), which
            // forces a full TUI redraw. If opencode is mid-stream, this causes
            // cursor positions to desync and text to overwrite itself — the
            // "HotovOvládání:" / partial-word bug. Only send when size actually
            // differs from what we told ConPTY at startup.
            //
            // The 150 ms slot is intentionally removed: it fires before any TUI
            // has even queried the terminal size, so it's always a no-op for the
            // correction case but still sends a pointless SIGWINCH.
            const scheduleConditionalResize = (delay: number) => {
              setTimeout(() => {
                if (destroyed.current || !ptyReady.current) return;
                fitSync();
                const { rows: r, cols: c } = readSafeTerminalSize();
                // Bail out if nothing changed — avoids spurious SIGWINCH.
                sendPtyResize(r, c);
              }, delay);
            };
            scheduleConditionalResize(700);   // after TUI queries initial size
            scheduleConditionalResize(1800);  // fallback for slow TUI boot

            // Transition to "running" after TUI boot warmup.
            setTimeout(() => {
              if (!destroyed.current) updateStatus("running");
            }, 3500);

            term.focus();
          } else {
            invoke("pty_kill", { sessionId }).catch(() => {});
          }
        })
        .catch((err) => {
          if (!destroyed.current) {
            term.writeln(`\x1b[31m✖ Cannot start '${command}': ${err}\x1b[0m`);
            term.writeln(`\x1b[33m  Make sure '${command}' is installed and in PATH.\x1b[0m`);
            term.writeln(`\x1b[2m  Type 'exit' or close this panel.\x1b[0m`);
            updateStatus("exited");
          }
        });
    };

    const cleanupFns: (() => void)[] = [];
    initTerminal();

    return () => {
      active = false;
      destroyed.current = true;
      ptyReady.current  = false;
      if (resizeTimeout) clearTimeout(resizeTimeout);
      cancelAnimationFrame(rafRef.current);
      cleanupFns.forEach(fn => fn());
      if (cleanupData) cleanupData();
      if (cleanupExit) cleanupExit();
      invoke("pty_kill", { sessionId }).catch(() => {});
      try { term.dispose(); } catch {}
    };
  }, [sessionId, command, workspaceDir]);

  // ── Force full repaint after grid drag-resize ends ────────────────────────────
  // TerminalGrid dispatches "termgrid-resize-end" when the user releases the
  // resize handle. At that point the CSS layout has settled and we can do a
  // definitive fit+refresh. We run three rounds to handle the ResizeObserver
  // micro-task ordering in WebView2 (canvas resize → buffer resize → repaint).
  useEffect(() => {
    const onResizeEnd = () => {
      const fit  = fitRef.current;
      const term = termRef.current;
      if (!fit || !term || destroyed.current) return;

      // Round 1 — immediate: recalculate cols/rows from new CSS size
      try { fit.fit(); } catch {}

      // Round 2 — after next paint: canvas element has been resized by xterm
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (destroyed.current) return;
          try {
            fit.fit();
            term.refresh(0, term.rows - 1);
          } catch {}
        });
      });

      // Round 3 — safety net at 220 ms: clears any residual stale pixels
      // that WebView2's async canvas compositing can leave behind
      setTimeout(() => {
        if (destroyed.current) return;
        try {
          fit.fit();
          term.refresh(0, term.rows - 1);
        } catch {}
      }, 220);
    };

    window.addEventListener("termgrid-resize-end", onResizeEnd);
    return () => window.removeEventListener("termgrid-resize-end", onResizeEnd);
  }, []);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) {
      window.addEventListener("mousedown", handleOutsideClick);
    }
    return () => {
      window.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [dropdownOpen]);

  const agents = [
    { label: "Shell", command: "shell", icon: "bx-terminal" },
    { label: "opencode", command: "opencode", icon: "bx-code-alt" },
    { label: "Claude", command: "claude", icon: "bx-bot" },
    { label: "Antigravity", command: "antigravity", icon: "bx-rocket" },
  ];

  const dragCounter = useRef(0);

  const handleDragStart = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDragEnd = (e: React.DragEvent) => {
    console.log(`[DragEnd] Panel ID: ${id}`);
    (window as any).draggedTerminalId = null;
    e.currentTarget.closest(".term-pane")?.classList.remove("dragging");
    // After drag the canvas may have stale pixels. doFit() handles the
    // deferred refresh correctly (fit → wait one frame → refresh).
    // We fire it twice: once immediately and once after layout fully settles.
    if (fitRef.current && termRef.current) {
      try { fitRef.current.fit(); } catch {}
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!destroyed.current && termRef.current) {
            try { termRef.current.refresh(0, termRef.current.rows - 1); } catch {}
          }
        });
      });
    }
    setTimeout(() => {
      if (!destroyed.current && fitRef.current && termRef.current) {
        try { fitRef.current.fit(); } catch {}
        requestAnimationFrame(() => {
          if (!destroyed.current && termRef.current) {
            try { termRef.current.refresh(0, termRef.current.rows - 1); } catch {}
          }
        });
      }
    }, 150);
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) {
      e.currentTarget.closest(".term-pane")?.classList.add("drag-over");
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      e.currentTarget.closest(".term-pane")?.classList.remove("drag-over");
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    e.currentTarget.closest(".term-pane")?.classList.remove("drag-over");
    
    const draggedId = (window as any).draggedTerminalId;
    console.log(`[Drop] Target Panel ID: ${id}, Dragged Panel ID from window: ${draggedId}`);
    if (draggedId !== undefined && draggedId !== null && draggedId !== id) {
      console.log(`[Drop] Triggering swap: ${draggedId} <-> ${id}`);
      onSwapSessions?.(draggedId, id);
    } else {
      const draggedIdStr = e.dataTransfer.getData("text/plain");
      const draggedIdNum = parseInt(draggedIdStr, 10);
      console.log(`[Drop] Dragged Panel ID from dataTransfer: ${draggedIdNum}`);
      if (!isNaN(draggedIdNum) && draggedIdNum !== id) {
        console.log(`[Drop] Triggering swap from dataTransfer: ${draggedIdNum} <-> ${id}`);
        onSwapSessions?.(draggedIdNum, id);
      }
    }
  };

  const dotCls   = status === "booting" ? "" : status === "exited" ? "err" : "ok";
  const dirShort = workspaceDir.split(/[\\/]/).pop() || workspaceDir;

  return (
    <div
      className={`term-pane${fullscreened ? " term-pane-fullscreen" : ""}`}
      draggable={false}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Tab bar */}
      <div className="term-bar">
        <div className="term-traffic">
          <div className="term-dot" />
          <div className="term-dot" />
          <div className={`term-dot ${dotCls}`} />
        </div>
        
        {/* Agent Dropdown Selector */}
        <div className="term-agent-dropdown-wrapper" ref={dropdownRef}>
          <button
            className="term-agent-dropdown-trigger"
            onClick={() => setDropdownOpen(!dropdownOpen)}
            title="Switch agent type"
          >
            {label}
            <i className={`bx bx-chevron-down ${dropdownOpen ? "open" : ""}`} />
          </button>
          {dropdownOpen && (
            <div className="term-agent-dropdown-menu">
              {agents.map((ag) => (
                <button
                  key={ag.label}
                  className={`term-agent-dropdown-item ${ag.label === label ? "active" : ""}`}
                  onClick={() => {
                    onChangeAgent(id, ag.label, ag.command);
                    setDropdownOpen(false);
                  }}
                >
                  <i className={`bx ${ag.icon}`} />
                  <span className="term-agent-item-name">{ag.label}</span>
                  {ag.label === label && <i className="bx bx-check term-agent-item-check" />}
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="term-badge">#{id + 1}</span>
        {status === "exited" && <span className="term-exited-label">exited</span>}
        <span className="term-path">{dirShort}</span>
        <button
          className="term-close-btn"
          title={fullscreened ? "Exit fullscreen (Esc)" : "Fullscreen"}
          onClick={() => onToggleFullscreen?.(id)}
        >
          <i className={`bx ${fullscreened ? "bx-exit-fullscreen" : "bx-fullscreen"}`} />
        </button>
        <button
          className="term-close-btn"
          title="Close"
          onClick={() => {
            ptyReady.current  = false;
            destroyed.current = true;
            invoke("pty_kill", { sessionId }).catch(() => {});
            onClose(id);
          }}
        >
          <i className="bx bx-x" />
        </button>
      </div>

      {/* xterm container — FitAddon reads THIS element's dimensions */}
      <div
        ref={containerRef}
        className="term-xterm-container"
        onClick={() => termRef.current?.focus()}
      />
    </div>
  );
};
