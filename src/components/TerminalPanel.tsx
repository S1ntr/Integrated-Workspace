import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
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
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  id,
  sessionId,
  label,
  command,
  workspaceDir,
  onClose,
  onChangeAgent,
}) => {
  const containerRef  = useRef<HTMLDivElement>(null);
  const termRef       = useRef<Terminal | null>(null);
  const fitRef        = useRef<FitAddon | null>(null);
  const rafRef        = useRef<number>(0);
  const unlistenData  = useRef<UnlistenFn | null>(null);
  const unlistenExit  = useRef<UnlistenFn | null>(null);
  const ptyReady      = useRef(false);
  const destroyed     = useRef(false);

  const [status, setStatus] = useState<"booting" | "running" | "exited">("booting");

  useEffect(() => {
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

    // ── 2. Fit helper: debounced with double-RAF ──────────────────────────────
    // Double RAF ensures browser has recalculated layout before we measure.
    const doFit = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (destroyed.current) return;
          try {
            fit.fit();
            if (ptyReady.current) {
              invoke("pty_resize", {
                sessionId,
                rows: term.rows,
                cols: term.cols,
              }).catch(() => {});
            }
          } catch {}
        });
      });
    };

    // Initial fit
    doFit();

    // ── 3. PTY events ─────────────────────────────────────────────────────────
    listen<string>(`pty-data-${sessionId}`, (e) => {
      if (!destroyed.current) term.write(e.payload);
    }).then(fn => { unlistenData.current = fn; });

    listen(`pty-exit-${sessionId}`, () => {
      if (!destroyed.current) {
        setStatus("exited");
        term.writeln("\r\n\x1b[38;2;82;82;91m── process exited ──\x1b[0m");
      }
    }).then(fn => { unlistenExit.current = fn; });

    // ── 4. Keyboard → PTY ─────────────────────────────────────────────────────
    term.onData((data) => {
      if (!ptyReady.current || destroyed.current) return;
      invoke("pty_write", { sessionId, data }).catch(() => {});
    });

    // ── 5. ResizeObserver — refit on any container size change ───────────────
    const ro = new ResizeObserver(doFit);
    ro.observe(el);

    // ── 6. Launch PTY after initial fit settles ───────────────────────────────
    // We wait ~3 frames so FitAddon has set rows/cols before we spawn
    let frameCount = 0;
    const waitForFit = () => {
      if (destroyed.current) return;
      frameCount++;
      if (frameCount < 3) {
        requestAnimationFrame(waitForFit);
        return;
      }
      const rows = term.rows > 0 ? term.rows : 24;
      const cols = term.cols > 0 ? term.cols : 80;
      invoke("pty_create", { sessionId, command, cwd: workspaceDir, rows, cols })
        .then(() => {
          if (!destroyed.current) {
            ptyReady.current = true;
            setStatus("running");
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
            setStatus("exited");
          }
        });
    };
    requestAnimationFrame(waitForFit);

    return () => {
      destroyed.current = true;
      ptyReady.current  = false;
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      unlistenData.current?.();
      unlistenExit.current?.();
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

  const dotCls   = status === "booting" ? "" : status === "exited" ? "err" : "ok";
  const dirShort = workspaceDir.split(/[\\/]/).pop() || workspaceDir;

  return (
    <div className="term-pane">
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
