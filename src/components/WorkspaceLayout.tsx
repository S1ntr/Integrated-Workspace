import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Sidebar, FileEntry } from "./Sidebar";
import { ChatPanel, type MentionFile, type TerminalTranscriptEntry } from "./ChatPanel";
import { BrowserOverlay } from "./BrowserOverlay";
import { TerminalGrid, Session } from "./TerminalGrid";
import { ChangesViewer, ChangedFile } from "./ChangesViewer";
import type { AgentSession } from "./Onboarding";
import type { BrowserOpenRequest, ExternalChatPrompt } from "../types/browser";
import { SettingsDialog } from "./SettingsDialog";
import { FileViewerDialog } from "./FileViewerDialog";
import { useNotify } from "./Notification";

interface WorkspaceLayoutProps {
  workspaceId?: string;
  directory: string;
  initialSessions: AgentSession[];
  isActive?: boolean;
  onWorkspaceActivity?: () => void;
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
  workspaceId?: string;
  directory: string;
  sessions: Session[];
  terminalOutputs: Record<string, string>;
  terminalTranscripts: Record<string, TerminalTranscriptEntry[]>;
  changedFiles: ChangedFile[];
  baselineSnapshot: Record<string, string>;
  onFileSelect: (path: string, name: string, baselineContent?: string) => void;
  onSendPtyCommand: (sessId: string, cmd: string) => void;
  onAddSession: (label: string, command: string) => Session;
  onCloseSession: (id: number) => void;
  onRestartSession?: (id: number) => string;
  onChangeSessionAgent?: (id: number, label: string, command: string, restart?: boolean) => string | void;
}

const RightPanel: React.FC<RightPanelProps> = ({
  width,
  workspaceId,
  directory,
  sessions,
  terminalOutputs,
  terminalTranscripts,
  changedFiles,
  baselineSnapshot,
  onFileSelect,
  onSendPtyCommand,
  onAddSession,
  onCloseSession,
  onRestartSession,
  onChangeSessionAgent,
}) => {
  const [tab, setTab] = useState<"chat" | "file">("chat");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserRequest, setBrowserRequest] = useState<BrowserOpenRequest | null>(null);
  const [externalPrompt, setExternalPrompt] = useState<ExternalChatPrompt | null>(null);

  const suggestedUrls = React.useMemo(() => {
    const urls = new Set<string>();
    const text = Object.values(terminalOutputs).join("\n");
    const matches = text.match(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s'"<>)]*/gi) || [];
    for (const raw of matches) {
      urls.add(raw.replace(/^http:\/\/0\.0\.0\.0/i, "http://127.0.0.1").replace(/^https:\/\/0\.0\.0\.0/i, "https://127.0.0.1"));
    }
    return Array.from(urls).slice(0, 6);
  }, [terminalOutputs]);

  const mentionFiles = React.useMemo<MentionFile[]>(() => {
    const map = new Map<string, MentionFile>();
    for (const path of Object.keys(baselineSnapshot)) {
      map.set(path, { path, name: path.split(/[\\/]/).pop() || path });
    }
    for (const file of changedFiles) {
      map.set(file.path, { path: file.path, name: file.name });
    }
    return Array.from(map.values());
  }, [baselineSnapshot, changedFiles]);

  const openBrowser = (request?: Omit<BrowserOpenRequest, "id"> | BrowserOpenRequest) => {
    setBrowserRequest({
      id: "id" in (request || {}) ? (request as BrowserOpenRequest).id : `browser-${Date.now()}`,
      label: request?.label,
      url: request?.url || suggestedUrls[0],
      device: request?.device,
    });
    setBrowserOpen(true);
  };

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
        <button
          className={`rp-tab ${browserOpen ? "active" : ""}`}
          onClick={() => openBrowser()}
        >
          <i className="bx bx-globe" />
          Browser
        </button>
      </div>

      <div className="right-panel-body">
        {tab === "chat" ? (
          <ChatPanel
            embedded
            workspaceDir={directory}
            chatStorageScope={workspaceId || directory}
            sessions={sessions}
            terminalOutputs={terminalOutputs}
            terminalTranscripts={terminalTranscripts}
            externalPrompt={externalPrompt}
            mentionFiles={mentionFiles}
            changedFiles={changedFiles}
            onSendPtyCommand={onSendPtyCommand}
            onAddSession={onAddSession}
            onCloseSession={onCloseSession}
            onRestartSession={onRestartSession}
            onChangeSessionAgent={onChangeSessionAgent}
            onOpenBrowser={openBrowser}
            onOpenDiffFile={(path, name) => onFileSelect(path, name, baselineSnapshot[path])}
          />
        ) : (
        <ChangesViewer
            changedFiles={changedFiles}
            baselineSnapshot={baselineSnapshot}
            onFileSelect={onFileSelect}
            workspaceDir={directory}
          />
        )}
      </div>
      <BrowserOverlay
        open={browserOpen}
        request={browserRequest}
        suggestedUrls={suggestedUrls}
        workspaceName={directory.split(/[\\/]/).pop() || directory}
        directory={directory}
        onClose={() => setBrowserOpen(false)}
        onSendToChat={(payload) => {
          setTab("chat");
          setExternalPrompt({ id: `browser-prompt-${Date.now()}`, ...payload });
        }}
        onAutoStartSession={(label, command) => {
          onAddSession(label, command);
        }}
      />
    </div>
  );
};

// ── Session counter ────────────────────────────────────────────────────────────
let globalSessionCounter = 0;

// ── Main Component ─────────────────────────────────────────────────────────────
export const WorkspaceLayout: React.FC<WorkspaceLayoutProps> = ({
  workspaceId,
  directory,
  initialSessions,
  isActive = true,
  onWorkspaceActivity,
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
  const [baselineReady, setBaselineReady] = useState(false);
  const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);
  const [terminalOutputs, setTerminalOutputs] = useState<Record<string, string>>({});
  const [terminalTranscripts, setTerminalTranscripts] = useState<Record<string, TerminalTranscriptEntry[]>>({});

  // Transcript batching — accumulate PTY output chunks per session, flush every 350ms.
  // Prevents flooding transcript (and thus LLM context) with 100s of tiny entries per second.
  const transcriptBatchRef = React.useRef<Record<string, string>>({});
  const transcriptBatchTimerRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // We need a stable reference to appendTerminalTranscript for the batch flush closure.
  const appendTerminalTranscriptRef = React.useRef<((s: Pick<Session, "sessionId" | "label">, k: TerminalTranscriptEntry["kind"], t: string) => void) | null>(null);

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

  const appendTerminalTranscript = (
    session: Pick<Session, "sessionId" | "label">,
    kind: TerminalTranscriptEntry["kind"],
    text: string,
  ) => {
    const trimmed = text.replace(/\s+$/g, "");
    if (!trimmed) return;
    onWorkspaceActivity?.();
    setTerminalTranscripts(prev => {
      const entry: TerminalTranscriptEntry = {
        id: `${session.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sessionId: session.sessionId,
        label: session.label,
        kind,
        text: trimmed.slice(-1600),
        ts: Date.now(),
      };
      const current = prev[session.sessionId] || [];
      return { ...prev, [session.sessionId]: [...current, entry].slice(-120) };
    });
  };
  // Keep ref in sync so batch-flush closures always call the latest version
  appendTerminalTranscriptRef.current = appendTerminalTranscript;

  // ── Baseline Snapshotting ────────────────────────────────────────────────
  useEffect(() => {
    if (!directory || !isActive) return;
    void invoke("set_active_workspace", { dirPath: directory });
    if (baselineReady) return;
    setBaselineReady(false);
    setChangedFiles([]);
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
        setBaselineReady(true);
      } catch (err) {
        console.error("Failed to take baseline snapshot:", err);
        setBaselineSnapshot({});
        setBaselineReady(true);
      }
    };
    takeBaseline();
  }, [directory, isActive, baselineReady]);

  // ── Periodic Files Scanner (every 2.5s) ──────────────────────────────────
  useEffect(() => {
    if (!directory || !baselineReady || !isActive) return;

    const scan = async () => {
      try {
        const entries = await invoke<FileEntry[]>("list_files", { dirPath: directory });
        const currentFiles = collectAllFiles(entries);
        const changes: ChangedFile[] = [];

        for (const f of currentFiles) {
          if (!Object.prototype.hasOwnProperty.call(baselineSnapshot, f.path)) {
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

    scan();
    const id = setInterval(scan, 2500);
    return () => clearInterval(id);
  }, [directory, baselineSnapshot, baselineReady, isActive]);



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

        // Accumulate raw output immediately (used by LLM as rolling window)
        setTerminalOutputs(prev => {
          const current = prev[session.sessionId] || "";
          const updated = (current + cleaned).slice(-4000);
          return { ...prev, [session.sessionId]: updated };
        });

        // Batch transcript entries: accumulate for 350ms then flush as one entry.
        // Prevents flooding transcript (and React state) with 100s of micro-entries/second.
        const sid = session.sessionId;
        transcriptBatchRef.current[sid] = (transcriptBatchRef.current[sid] || "") + cleaned;
        if (transcriptBatchTimerRef.current[sid]) {
          clearTimeout(transcriptBatchTimerRef.current[sid]);
        }
        transcriptBatchTimerRef.current[sid] = setTimeout(() => {
          const batched = transcriptBatchRef.current[sid] || "";
          delete transcriptBatchRef.current[sid];
          delete transcriptBatchTimerRef.current[sid];
          if (batched.trim()) {
            appendTerminalTranscriptRef.current?.(session, "output", batched);
          }
        }, 350);
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
    const target = sessions.find(s => s.id === termId);
    if (target) {
      setTerminalOutputs(outputs => {
        const next = { ...outputs };
        delete next[target.sessionId];
        return next;
      });
      setTerminalTranscripts(transcripts => {
        const next = { ...transcripts };
        delete next[target.sessionId];
        return next;
      });
    }
    setSessions(prev => prev.filter(s => s.id !== termId));
  };

  const changeSessionAgent = (termId: number, label: string, command: string, restart = true): string | void => {
    let finalCommand = command;
    if (command === "claude" && localStorage.getItem("__integraded_claude_skip_permissions") !== "0") {
      finalCommand = "claude --dangerously-skip-permissions";
    }
    const newSessionId = restart ? `pty-${termId}-${Date.now()}` : undefined;
    const currentSessionId = sessions.find(s => s.id === termId)?.sessionId;
    setSessions(prev => prev.map(s => {
      if (s.id === termId) {
        return {
          ...s,
          label,
          command: finalCommand,
          // Only generate new sessionId (= PTY restart) when explicitly requested.
          // Keeping the same sessionId preserves agent context.
          sessionId: restart ? newSessionId! : s.sessionId,
        };
      }
      return s;
    }));
    return newSessionId || currentSessionId;
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
    if (status === "booting" || status === "running") onWorkspaceActivity?.();
    // Record status transition so LLM context shows terminal state changes
    setSessions(prev => {
      const session = prev.find(s => s.id === termId);
      if (session) {
        const label = status === "booting" ? "↺ Terminal restarting"
          : status === "running" ? "✓ Terminal ready"
          : "✗ Terminal process exited";
        appendTerminalTranscriptRef.current?.(session, "system", label);
      }
      return prev.map(s => s.id === termId ? { ...s, status } : s);
    });
  };

  const restartSession = (termId: number): string => {
    const newSessId = `pty-${termId}-${Date.now()}`;
    setSessions(prev => {
      const session = prev.find(s => s.id === termId);
      if (session) {
        appendTerminalTranscriptRef.current?.(session, "system", "↺ Session restarted (new PTY)");
      }
      return prev.map(s => s.id === termId ? { ...s, status: "booting", sessionId: newSessId } : s);
    });
    return newSessId;
  };

  const sendPtyCommand = (sessId: string, cmd: string) => {
    const session = sessions.find(s => s.sessionId === sessId);
    if (session) appendTerminalTranscript(session, "input", cmd);
    invoke("pty_write", { sessionId: sessId, data: cmd + "\r" }).catch(() => {});
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
        <div className="header-spacer" data-tauri-drag-region />
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
              active={isActive}
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
              workspaceId={workspaceId}
              directory={directory}
              sessions={sessions}
              terminalOutputs={terminalOutputs}
              terminalTranscripts={terminalTranscripts}
              changedFiles={changedFiles}
              baselineSnapshot={baselineSnapshot}
              onFileSelect={(path, name, baselineContent) => setActiveFile({ path, name, baselineContent: baselineContent ?? baselineSnapshot[path] })}
              onSendPtyCommand={sendPtyCommand}
              onAddSession={addSession}
              onCloseSession={closeSession}
              onRestartSession={restartSession}
              onChangeSessionAgent={changeSessionAgent}
            />
          </>
        )}
      </div>
    </div>
  );
};
