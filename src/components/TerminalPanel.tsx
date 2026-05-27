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
  onClose: (id: number) => void;
  onChangeAgent: (id: number, label: string, command: string) => void;
  onSwapSessions?: (idA: number, idB: number) => void;
  onStatusChange?: (id: number, status: "booting" | "running" | "exited") => void;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  id,
  sessionId,
  label,
  command,
  workspaceDir,
  onClose,
  onChangeAgent,
  onSwapSessions,
  onStatusChange,
}) => {
  const containerRef  = useRef<HTMLDivElement>(null);
  const termRef       = useRef<Terminal | null>(null);
  const fitRef        = useRef<FitAddon | null>(null);
  const rafRef        = useRef<number>(0);
  const ptyReady      = useRef(false);
  const destroyed     = useRef(false);

  const [status, setStatus] = useState<"booting" | "running" | "exited">("booting");

  const updateStatus = (newStatus: "booting" | "running" | "exited") => {
    setStatus(newStatus);
    onStatusChange?.(id, newStatus);
  };


  useEffect(() => {
    updateStatus("booting");
    const el = containerRef.current;
    if (!el) return;

    destroyed.current = false;
    ptyReady.current  = false;

    // ── 1. Create Terminal ────────────────────────────────────────────────────
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
      fontFamily:        "'IBM Plex Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      fontSize:          13,
      lineHeight:        1.45,
      letterSpacing:     0.2,
      cursorBlink:       true,
      cursorStyle:       "block",
      scrollback:        5000,
      allowTransparency: false,
      convertEol:        true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);  // attaches to DOM — must happen before first fit()

    termRef.current = term;
    fitRef.current  = fit;

    // ── 2. Fit helper: debounced with double-RAF & backend resize throttling ────
    // FitAddon is called immediately so canvas feels super responsive, but
    // backend PTY resizing is throttled/debounced to keep ConPTY stable.
    let resizeTimeout: any = null;
    const doFit = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (destroyed.current) return;
          try {
            fit.fit();
            if (ptyReady.current) {
              if (resizeTimeout) clearTimeout(resizeTimeout);
              resizeTimeout = setTimeout(() => {
                if (destroyed.current || !ptyReady.current) return;
                invoke("pty_resize", {
                  sessionId,
                  rows: term.rows,
                  cols: term.cols,
                }).catch(() => {});
              }, 100);
            }
          } catch {}
        });
      });
    };

    // Initial fit
    doFit();
    let active = true;
    let cleanupData: (() => void) | null = null;
    let cleanupExit: (() => void) | null = null;

    // ── 3. PTY events ─────────────────────────────────────────────────────────
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

    // ── 4. Keyboard → PTY ─────────────────────────────────────────────────────
    term.onData((data) => {
      if (!ptyReady.current || destroyed.current) return;
      invoke("pty_write", { sessionId, data }).catch(() => {});
    });

    // ── 5. ResizeObserver — refit on any container size change ───────────────
    const ro = new ResizeObserver(doFit);
    ro.observe(el);

    // ── 6. Launch PTY after initial fit settles ───────────────────────────────
    // We wait 400ms so CSS animations and layouts have fully settled before we measure dimensions
    const waitForFit = () => {
      if (destroyed.current) return;
      
      // Ensure FitAddon runs a final fit right before we measure and spawn
      try { fit.fit(); } catch {}
      
      const rows = term.rows > 0 ? term.rows : 24;
      const cols = term.cols > 0 ? term.cols : 80;
      
      invoke("pty_create", { sessionId, command, cwd: workspaceDir, rows, cols })
        .then(() => {
          if (!destroyed.current) {
            ptyReady.current = true;
            // Let the TUI or shell warm up for 3.5 seconds before transitioning to "running"
            setTimeout(() => {
              if (!destroyed.current) {
                updateStatus("running");
              }
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
    
    const mountTimeout = setTimeout(waitForFit, 400);

    return () => {
      active = false;
      destroyed.current = true;
      ptyReady.current  = false;
      clearTimeout(mountTimeout);
      if (resizeTimeout) clearTimeout(resizeTimeout);
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      if (cleanupData) cleanupData();
      if (cleanupExit) cleanupExit();
      invoke("pty_kill", { sessionId }).catch(() => {});
      try { term.dispose(); } catch {}
    };
  }, [sessionId, command, workspaceDir]);

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
    // Only allow dragging if the user initiated the drag from the term-bar (or its children)
    const target = e.target as HTMLElement;
    if (!target.closest(".term-bar") || target.closest("button") || target.closest(".term-agent-dropdown-menu")) {
      e.preventDefault();
      return;
    }

    console.log(`[DragStart] Panel ID: ${id}`);
    e.dataTransfer.setData("text/plain", id.toString());
    e.dataTransfer.effectAllowed = "move";
    (window as any).draggedTerminalId = id;
    
    // Add dragging class natives to parent panel
    e.currentTarget.closest(".term-pane")?.classList.add("dragging");
  };

  const handleDragEnd = (e: React.DragEvent) => {
    console.log(`[DragEnd] Panel ID: ${id}`);
    (window as any).draggedTerminalId = null;
    e.currentTarget.closest(".term-pane")?.classList.remove("dragging");
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
      className="term-pane"
      draggable={true}
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
