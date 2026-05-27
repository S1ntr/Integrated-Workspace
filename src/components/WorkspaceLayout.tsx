import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Sidebar, FileEntry } from "./Sidebar";
import { ChatPanel } from "./ChatPanel";
import { TerminalGrid, Session } from "./TerminalGrid";
import { ChangesViewer, ChangedFile } from "./ChangesViewer";
import type { AgentSession } from "./Onboarding";
import { SettingsDialog } from "./SettingsDialog";
import { FileViewerDialog } from "./FileViewerDialog";
import { useNotify } from "./Notification";

interface WorkspaceLayoutProps {
  directory: string;
  initialSessions: AgentSession[];
}

// ── Agent options for dialog ───────────────────────────────────────────────────
const AGENT_OPTIONS = [
  { key: "shell",       label: "Shell",       command: "shell",       icon: "bx-terminal",  desc: "Native PowerShell / bash" },
  { key: "opencode",   label: "opencode",    command: "opencode",    icon: "bx-code-alt",  desc: "opencode.ai — AI coding agent" },
  { key: "codex",      label: "Codex CLI",   command: "codex",       icon: "bx-terminal",  desc: "OpenAI Codex CLI agent" },
  { key: "claude",     label: "Claude",      command: "claude",      icon: "bx-bot",       desc: "Anthropic Claude CLI" },
  { key: "antigravity",label: "Antigravity", command: "antigravity", icon: "bx-rocket",    desc: "Antigravity CLI agent" },
];

// ── New Session Dialog ─────────────────────────────────────────────────────────
interface NewSessionDialogProps {
  remainingCount: number;
  onConfirm: (label: string, command: string, count: number) => void;
  onCancel: () => void;
}

const NewSessionDialog: React.FC<NewSessionDialogProps> = ({ remainingCount, onConfirm, onCancel }) => {
  const [selected, setSelected] = useState("shell");
  const [count, setCount] = useState(1);
  const [skipPerms, setSkipPerms] = useState(localStorage.getItem("__integraded_claude_skip_permissions") !== "0");
  const pick = AGENT_OPTIONS.find(a => a.key === selected) ?? AGENT_OPTIONS[0];

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-box" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <span className="dialog-title">New Terminal Session</span>
          <button className="dialog-close" onClick={onCancel}><i className="bx bx-x" /></button>
        </div>
        <div className="dialog-body">
          {AGENT_OPTIONS.map(a => (
            <div
              key={a.key}
              className={`dialog-option ${selected === a.key ? "selected" : ""}`}
              onClick={() => setSelected(a.key)}
            >
              <i className={`bx ${a.icon}`} />
              <div className="dialog-option-text">
                <span className="dialog-option-name">{a.label}</span>
                <span className="dialog-option-desc">{a.desc}</span>
              </div>
              {selected === a.key && <i className="bx bxs-check-circle dialog-check" />}
            </div>
          ))}

          <div className="dialog-count-picker">
            <span className="dialog-count-label">Instances to open:</span>
            <div className="dialog-count-controls">
              <button
                type="button"
                className="dialog-count-btn"
                disabled={count <= 1}
                onClick={() => setCount(c => Math.max(1, c - 1))}
              >
                <i className="bx bx-minus" />
              </button>
              <span className="dialog-count-value">{count}</span>
              <button
                type="button"
                className="dialog-count-btn"
                disabled={count >= remainingCount}
                onClick={() => setCount(c => Math.min(remainingCount, c + 1))}
              >
                <i className="bx bx-plus" />
              </button>
            </div>
            <span className="dialog-count-hint">(Max remaining: {remainingCount})</span>
          </div>

          {selected === "claude" && (
            <label className="dialog-claude-skip" onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={skipPerms}
                onChange={e => {
                  setSkipPerms(e.target.checked);
                  localStorage.setItem("__integraded_claude_skip_permissions", e.target.checked ? "1" : "0");
                }}
              />
              <span className="dialog-claude-skip-label">
                Skip permissions <code>--dangerously-skip-permissions</code>
              </span>
            </label>
          )}
        </div>
        <div className="dialog-footer">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={() => {
            const cmd = selected === "claude" && skipPerms ? "claude --dangerously-skip-permissions" : pick.command;
            onConfirm(pick.label, cmd, count);
          }}>
            <i className="bx bx-play" />
            Launch
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Right Panel with tabs ──────────────────────────────────────────────────────
interface RightPanelProps {
  width: number;
  sessions: Session[];
  terminalOutputs: Record<string, string>;
  changedFiles: ChangedFile[];
  baselineSnapshot: Record<string, string>;
  onFileSelect: (path: string, name: string) => void;
  onSendPtyCommand: (sessId: string, cmd: string) => void;
  onAddSession: (label: string, command: string) => Session;
  onCloseSession: (id: number) => void;
  onRestartSession?: (id: number) => string;
}

const RightPanel: React.FC<RightPanelProps> = ({
  width,
  sessions,
  terminalOutputs,
  changedFiles,
  baselineSnapshot,
  onFileSelect,
  onSendPtyCommand,
  onAddSession,
  onCloseSession,
  onRestartSession,
}) => {
  const [tab, setTab] = useState<"chat" | "file">("chat");

  return (
    <div className="right-panel" style={{ width }}>
      <div className="right-panel-tabs">
        <button
          className={`rp-tab ${tab === "chat" ? "active" : ""}`}
          onClick={() => setTab("chat")}
        >
          <i className="bx bx-message-square-detail" />
          Chat
        </button>
        <button
          className={`rp-tab ${tab === "file" ? "active" : ""}`}
          onClick={() => setTab("file")}
        >
          <i className="bx bx-git-branch" />
          Changes
          {changedFiles.length > 0 && <span className="rp-tab-badge">{changedFiles.length}</span>}
        </button>
      </div>

      <div className="right-panel-body">
        {tab === "chat" ? (
          <ChatPanel
            embedded
            sessions={sessions}
            terminalOutputs={terminalOutputs}
            onSendPtyCommand={onSendPtyCommand}
            onAddSession={onAddSession}
            onCloseSession={onCloseSession}
            onRestartSession={onRestartSession}
          />
        ) : (
          <ChangesViewer
            changedFiles={changedFiles}
            baselineSnapshot={baselineSnapshot}
            onFileSelect={onFileSelect}
          />
        )}
      </div>
    </div>
  );
};

// ── Session counter ────────────────────────────────────────────────────────────
let globalSessionCounter = 0;

// ── Main Component ─────────────────────────────────────────────────────────────
export const WorkspaceLayout: React.FC<WorkspaceLayoutProps> = ({
  directory,
  initialSessions,
}) => {
  // Default Claude bypass ON
  if (localStorage.getItem("__integraded_claude_skip_permissions") === null) {
    localStorage.setItem("__integraded_claude_skip_permissions", "1");
  }

  const [sidebarW, setSidebarW] = useState(220);
  const [rightW, setRightW] = useState(300);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [showNewSession, setShowNewSession] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeFile, setActiveFile] = useState<{ path: string; name: string; baselineContent?: string } | null>(null);

  // New States for Changes & Diff tracking
  const [baselineSnapshot, setBaselineSnapshot] = useState<Record<string, string>>({});
  const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);
  const [terminalOutputs, setTerminalOutputs] = useState<Record<string, string>>({});

  // Helper to recursively collect all file entries (leaves only)
  const collectAllFiles = (entries: FileEntry[]): FileEntry[] => {
    const result: FileEntry[] = [];
    const recurse = (list: FileEntry[]) => {
      for (const entry of list) {
        if (entry.is_dir) {
          if (entry.children) recurse(entry.children);
        } else {
          result.push(entry);
        }
      }
    };
    recurse(entries);
    return result;
  };

  // ── Baseline Snapshotting ────────────────────────────────────────────────
  useEffect(() => {
    if (!directory) return;
    const takeBaseline = async () => {
      try {
        // Initialize secure workspace scoping in backend first
        await invoke("set_active_workspace", { dirPath: directory });

        const entries = await invoke<FileEntry[]>("list_files", { dirPath: directory });
        const files = collectAllFiles(entries);
        const snapshot: Record<string, string> = {};
        for (const f of files) {
          try {
            const content = await invoke<string>("read_file_content", { filePath: f.path });
            snapshot[f.path] = content;
          } catch {
            snapshot[f.path] = "";
          }
        }
        setBaselineSnapshot(snapshot);
      } catch (err) {
        console.error("Failed to take baseline snapshot:", err);
      }
    };
    takeBaseline();
  }, [directory]);

  // ── Periodic Files Scanner (every 2.5s) ──────────────────────────────────
  useEffect(() => {
    if (!directory || Object.keys(baselineSnapshot).length === 0) return;

    const scan = async () => {
      try {
        const entries = await invoke<FileEntry[]>("list_files", { dirPath: directory });
        const currentFiles = collectAllFiles(entries);
        const changes: ChangedFile[] = [];

        for (const f of currentFiles) {
          if (!(f.path in baselineSnapshot)) {
            // Created file
            changes.push({ name: f.name, path: f.path, status: "new" });
          } else {
            // Modified file
            try {
              const currentContent = await invoke<string>("read_file_content", { filePath: f.path });
              const baselineContent = baselineSnapshot[f.path];
              if (currentContent !== baselineContent) {
                changes.push({ name: f.name, path: f.path, status: "modified" });
              }
            } catch {}
          }
        }
        setChangedFiles(changes);
      } catch (err) {
        console.error("Error scanning files for changes:", err);
      }
    };

    const id = setInterval(scan, 2500);
    return () => clearInterval(id);
  }, [directory, baselineSnapshot]);



  // ── Collect terminal output for orchestrator context ────────────────────
  useEffect(() => {
    if (sessions.length === 0) return;
    const unlisteners: (() => void)[] = [];

    for (const session of sessions) {
      listen<string>(`pty-data-${session.sessionId}`, (event) => {
        // Strip ANSI escape codes so LLM gets readable text
        const cleaned = event.payload
          .replace(/\x1b\[[0-9;]*[mGKHFJA-Za-z]/g, "")
          .replace(/\x1b\][^\x07]*\x07/g, "")
          .replace(/\r/g, "");
        setTerminalOutputs(prev => {
          const current = prev[session.sessionId] || "";
          const updated = (current + cleaned).slice(-4000);
          return { ...prev, [session.sessionId]: updated };
        });
      }).then(unlisten => unlisteners.push(unlisten));
    }

    return () => { for (const u of unlisteners) u(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.map(s => s.sessionId).join(",")]);

  // ── Init sessions from onboarding config ───────────────────────────────
  useEffect(() => {
    if (sessions.length > 0) return;
    const initial: Session[] = (initialSessions.length > 0 ? initialSessions : [{ label: "shell", command: "shell" }])
      .map((s) => ({ id: globalSessionCounter++, sessionId: `pty-${globalSessionCounter - 1}`, label: s.label, command: s.command }));
    setSessions(initial);
  }, []);



  // ── Session management ───────────────────────────────────────────────────
  const addSession = (label: string, command: string, count = 1): Session => {
    setShowNewSession(false);
    if (sessions.length + count > 16) {
      notifyError(`Cannot open ${count} terminals. Maximum limit of 16 terminal sessions reached.`);
      return { id: -1, sessionId: "", label: "", command: "" };
    }

    // If Claude and skip-permissions toggle is on, append the flag
    let finalCommand = command;
    if (command === "claude" && localStorage.getItem("__integraded_claude_skip_permissions") !== "0") {
      finalCommand = "claude --dangerously-skip-permissions";
    }

    let lastSession: Session = { id: -1, sessionId: "", label: "", command: "" };

    setSessions(prev => {
      const next = [...prev];
      for (let c = 0; c < count; c++) {
        const id = globalSessionCounter++;
        const sLabel = count > 1 ? `${label} #${c + 1}` : label;
        const session: Session = { id, sessionId: `pty-${id}`, label: sLabel, command: finalCommand };
        next.push(session);
        lastSession = session;
      }
      return next;
    });

    return lastSession;
  };

  // Ctrl+T / Cmd+T → new terminal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 't') {
        e.preventDefault();
        addSession("shell", "shell");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const closeSession = (termId: number) => {
    setSessions(prev => prev.filter(s => s.id !== termId));
  };

  const changeSessionAgent = (termId: number, label: string, command: string, restart = true) => {
    let finalCommand = command;
    if (command === "claude" && localStorage.getItem("__integraded_claude_skip_permissions") !== "0") {
      finalCommand = "claude --dangerously-skip-permissions";
    }
    setSessions(prev => prev.map(s => {
      if (s.id === termId) {
        return {
          ...s,
          label,
          command: finalCommand,
          // Only generate new sessionId (= PTY restart) when explicitly requested.
          // Keeping the same sessionId preserves agent context.
          sessionId: restart ? `pty-${termId}-${Date.now()}` : s.sessionId,
        };
      }
      return s;
    }));
  };

  const swapSessions = (idA: number, idB: number) => {
    console.log(`[swapSessions] Swapping session IDs: ${idA} <-> ${idB}`);
    setSessions(prev => {
      const idxA = prev.findIndex(s => s.id === idA);
      const idxB = prev.findIndex(s => s.id === idB);
      console.log(`[swapSessions] Found indices: ${idxA} and ${idxB}`);
      if (idxA === -1 || idxB === -1) {
        console.warn(`[swapSessions] Could not find session indices!`);
        return prev;
      }
      const next = [...prev];
      const temp = next[idxA];
      next[idxA] = next[idxB];
      next[idxB] = temp;
      console.log(`[swapSessions] Array order updated successfully:`, next.map(s => s.id));
      return next;
    });
  };

  const handleStatusChange = (termId: number, status: "booting" | "running" | "exited") => {
    setSessions(prev => prev.map(s => s.id === termId ? { ...s, status } : s));
  };

  const restartSession = (termId: number): string => {
    const newSessId = `pty-${termId}-${Date.now()}`;
    console.log(`[restartSession] Restarting session ID: ${termId} with new session ID: ${newSessId}`);
    setSessions(prev => prev.map(s => {
      if (s.id === termId) {
        return {
          ...s,
          status: "booting",
          sessionId: newSessId,
        };
      }
      return s;
    }));
    return newSessId;
  };


  // ── Sidebar resize ───────────────────────────────────────────────────────
  const resizeSidebar = (e: React.MouseEvent) => {
    e.preventDefault();
    const sx = e.clientX, sw = sidebarW;
    const onMove = (me: MouseEvent) => setSidebarW(Math.max(160, Math.min(480, sw + me.clientX - sx)));
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ── Right resize ─────────────────────────────────────────────────────────
  const resizeRight = (e: React.MouseEvent) => {
    e.preventDefault();
    const sx = e.clientX, rw = rightW;
    const onMove = (me: MouseEvent) => setRightW(Math.max(220, Math.min(560, rw - (me.clientX - sx))));
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const { notifyError } = useNotify();

  const dirShort = directory.split(/[\\/]/).pop() || directory;

  // Derive header pills from actual running sessions
  const sessionPills = sessions.reduce<{ label: string; count: number }[]>((acc, s) => {
    const ex = acc.find(p => p.label === s.label);
    if (ex) ex.count++;
    else acc.push({ label: s.label, count: 1 });
    return acc;
  }, []);

  return (
    <div className="app-shell">
      {showNewSession && (
        <NewSessionDialog
          remainingCount={16 - sessions.length}
          onConfirm={addSession}
          onCancel={() => setShowNewSession(false)}
        />
      )}
      {showSettings && (
        <SettingsDialog onClose={() => setShowSettings(false)} />
      )}
      {activeFile && (
        <FileViewerDialog
          filePath={activeFile.path}
          fileName={activeFile.name}
          onClose={() => setActiveFile(null)}
          baselineContent={activeFile.baselineContent}
        />
      )}

      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-brand">
          <img src="/logo.svg" className="header-logo" alt="" />
          <span className="header-name">Integraded</span>
        </div>
        <div className="header-pills-row">
          {sessionPills.slice(0, 3).map(p => (
            <div key={p.label} className="agent-pill running">
              <i className="bx bx-terminal" />
              <span className="agent-pill-label">{p.label}</span>
              {p.count > 1 && <span className="agent-pill-count">×{p.count}</span>}
            </div>
          ))}
          {sessionPills.length > 3 && (
            <div className="agent-pill running agent-pill-more">
              +{sessionPills.slice(3).reduce((n, p) => n + p.count, 0)}
            </div>
          )}
        </div>
        <div className="header-spacer" />
        <div className="header-path"><i className="bx bx-folder" />{dirShort}</div>
        <button
          className="hdr-btn"
          title="New terminal (Ctrl+T)"
          onClick={() => {
            if (sessions.length >= 16) {
              notifyError("Maximum limit of 16 terminal sessions reached.");
            } else {
              setShowNewSession(true);
            }
          }}
        >
          <i className="bx bx-plus" />
        </button>
        <button className={`hdr-btn ${sidebarOpen ? "active" : ""}`} title="Explorer" onClick={() => setSidebarOpen(o => !o)}>
          <i className="bx bx-sidebar" />
        </button>
        <button className={`hdr-btn ${rightOpen ? "active" : ""}`} title="Right panel" onClick={() => setRightOpen(o => !o)}>
          <i className="bx bx-layout" />
        </button>
        <button className={`hdr-btn ${showSettings ? "active" : ""}`} title="Settings" onClick={() => setShowSettings(o => !o)}>
          <i className="bx bx-cog" />
        </button>
      </header>

      {/* ── Body ── */}
      <div className="app-body">
        {sidebarOpen && (
          <>
            <Sidebar
              directory={directory}
              activeFilePath={activeFile?.path ?? null}
              onFileSelect={(path, name) => setActiveFile({ path, name })}
              width={sidebarW}
            />
            <div className="resize-handle h" onMouseDown={resizeSidebar} />
          </>
        )}

        <TerminalGrid
          sessions={sessions}
          workspaceDir={directory}
          onClose={closeSession}
          onChangeAgent={changeSessionAgent}
          onAddSessionClick={() => setShowNewSession(true)}
          onSwapSessions={swapSessions}
          onStatusChange={handleStatusChange}
        />

        {rightOpen && (
          <>
            <div className="resize-handle h" onMouseDown={resizeRight} />
            <RightPanel
              width={rightW}
              sessions={sessions}
              terminalOutputs={terminalOutputs}
              changedFiles={changedFiles}
              baselineSnapshot={baselineSnapshot}
              onFileSelect={(path, name) => setActiveFile({ path, name, baselineContent: baselineSnapshot[path] })}
              onSendPtyCommand={(sessId, cmd) => {
                invoke("pty_write", { sessionId: sessId, data: cmd + "\r" }).catch(() => {});
              }}
              onAddSession={addSession}
              onCloseSession={closeSession}
              onRestartSession={restartSession}
            />
          </>
        )}
      </div>
    </div>
  );
};
