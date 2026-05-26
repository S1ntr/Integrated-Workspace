import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./Sidebar";
import { ChatPanel } from "./ChatPanel";
import { TerminalGrid, Session } from "./TerminalGrid";
import type { AgentSession } from "./Onboarding";

interface WorkspaceLayoutProps {
  directory: string;
  initialSessions: AgentSession[];
}



// ── Grid layout helpers moved to TerminalGrid.tsx ─────────────────────────────

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
  onConfirm: (label: string, command: string) => void;
  onCancel: () => void;
}

const NewSessionDialog: React.FC<NewSessionDialogProps> = ({ onConfirm, onCancel }) => {
  const [selected, setSelected] = useState("shell");
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
        </div>
        <div className="dialog-footer">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onConfirm(pick.label, pick.command)}>
            <i className="bx bx-play" />
            Launch
          </button>
        </div>
      </div>
    </div>
  );
};

// ── File Viewer ─────────────────────────────────────────────────────────────────
interface FileViewerProps {
  file: { path: string; name: string } | null;
  content: string | null;
  onClose: () => void;
}

const FileViewer: React.FC<FileViewerProps> = ({ file, content, onClose }) => {
  if (!file || content === null) {
    return (
      <div className="file-viewer-empty">
        <i className="bx bx-file-blank" />
        <span>No file open</span>
        <span className="file-viewer-empty-hint">Click a file in the Explorer to preview it here</span>
      </div>
    );
  }

  const lines = content.split("\n");

  // Detect lang from extension for basic badge
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const langBadge: Record<string, string> = {
    ts: "TypeScript", tsx: "TSX", js: "JavaScript", jsx: "JSX",
    rs: "Rust", py: "Python", json: "JSON", md: "Markdown",
    css: "CSS", html: "HTML", toml: "TOML", yaml: "YAML", yml: "YAML",
    sh: "Shell", ps1: "PowerShell",
  };

  return (
    <div className="file-viewer">
      <div className="file-viewer-bar">
        <i className="bx bx-file-blank file-viewer-icon" />
        <span className="file-viewer-name">{file.name}</span>
        {langBadge[ext] && <span className="file-viewer-lang">{langBadge[ext]}</span>}
        <span className="file-viewer-lines">{lines.length} lines</span>
        <button className="file-viewer-close" onClick={onClose} title="Close file">
          <i className="bx bx-x" />
        </button>
      </div>
      <div className="file-viewer-content">
        <div className="file-viewer-gutter">
          {lines.map((_, i) => (
            <div key={i} className="file-viewer-ln">{i + 1}</div>
          ))}
        </div>
        <div className="file-viewer-code">
          {lines.map((line, i) => (
            <div key={i} className="file-viewer-line">{line || " "}</div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ── Right Panel with tabs ──────────────────────────────────────────────────────
interface RightPanelProps {
  width: number;
  activeFile: { path: string; name: string } | null;
  fileContent: string | null;
  onFileClose: () => void;
}

const RightPanel: React.FC<RightPanelProps> = ({ width, activeFile, fileContent, onFileClose }) => {
  const [tab, setTab] = useState<"chat" | "file">("chat");

  // Auto-switch to file tab when a file is opened
  useEffect(() => {
    if (activeFile) setTab("file");
  }, [activeFile?.path]);

  // Switch to chat when file is closed
  useEffect(() => {
    if (!activeFile && tab === "file") setTab("chat");
  }, [activeFile]);

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
          <i className="bx bx-file-blank" />
          File
          {activeFile && <span className="rp-tab-dot" />}
        </button>
      </div>

      <div className="right-panel-body">
        {tab === "chat" ? (
          <ChatPanel width={width} embedded />
        ) : (
          <FileViewer file={activeFile} content={fileContent} onClose={() => { onFileClose(); setTab("chat"); }} />
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
  const [sidebarW, setSidebarW] = useState(220);
  const [rightW, setRightW] = useState(300);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [showNewSession, setShowNewSession] = useState(false);
  const [activeFile, setActiveFile] = useState<{ path: string; name: string } | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);

  // ── Init sessions from onboarding config ───────────────────────────────
  useEffect(() => {
    if (sessions.length > 0) return;
    const initial: Session[] = (initialSessions.length > 0 ? initialSessions : [{ label: "shell", command: "shell" }])
      .map((s) => ({ id: globalSessionCounter++, sessionId: `pty-${globalSessionCounter - 1}`, label: s.label, command: s.command }));
    setSessions(initial);
  }, []);

  // ── Load file ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeFile) { setFileContent(null); return; }
    invoke<string>("read_file_content", { filePath: activeFile.path })
      .then(c => setFileContent(c))
      .catch(() => setFileContent("// Could not read file"));
  }, [activeFile]);

  // ── Session management ───────────────────────────────────────────────────
  const addSession = (label: string, command: string) => {
    setShowNewSession(false);
    const id = globalSessionCounter++;
    setSessions(prev => [...prev, { id, sessionId: `pty-${id}`, label, command }]);
  };

  const closeSession = (termId: number) => {
    setSessions(prev => prev.length <= 1 ? prev : prev.filter(s => s.id !== termId));
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
        <NewSessionDialog onConfirm={addSession} onCancel={() => setShowNewSession(false)} />
      )}

      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-brand">
          <img src="/logo.svg" className="header-logo" alt="" />
          <span className="header-name">Integraded</span>
        </div>
        {sessionPills.map(p => (
          <div key={p.label} className="agent-pill running">
            <i className="bx bx-terminal" />
            {p.label}{p.count > 1 ? ` ×${p.count}` : ""}
          </div>
        ))}
        <div className="header-spacer" />
        <div className="header-path"><i className="bx bx-folder" />{dirShort}</div>
        <button className="hdr-btn" title="New terminal (Ctrl+T)" onClick={() => setShowNewSession(true)}>
          <i className="bx bx-plus" />
        </button>
        <button className={`hdr-btn ${sidebarOpen ? "active" : ""}`} title="Explorer" onClick={() => setSidebarOpen(o => !o)}>
          <i className="bx bx-sidebar" />
        </button>
        <button className={`hdr-btn ${rightOpen ? "active" : ""}`} title="Right panel" onClick={() => setRightOpen(o => !o)}>
          <i className="bx bx-layout" />
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

        {/* Terminal grid — resizable panels */}
        <TerminalGrid
          sessions={sessions}
          workspaceDir={directory}
          onClose={closeSession}
        />

        {rightOpen && (
          <>
            <div className="resize-handle h" onMouseDown={resizeRight} />
            <RightPanel
              width={rightW}
              activeFile={activeFile}
              fileContent={fileContent}
              onFileClose={() => setActiveFile(null)}
            />
          </>
        )}
      </div>
    </div>
  );
};
