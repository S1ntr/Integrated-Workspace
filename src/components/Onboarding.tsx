import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface AgentSession {
  label: string;
  command: string;
}

export interface OnboardingConfig {
  directory: string;
  sessions: AgentSession[]; // ordered flat list — WorkspaceLayout creates PTYs from this
}

interface OnboardingProps {
  onComplete: (config: OnboardingConfig) => void;
  onCancel?: () => void;
}

const AGENTS = [
  { key: "open_code",  label: "opencode",  command: "opencode",    icon: "bx-code-alt", color: "#c084fc", desc: "opencode.ai — AI coding agent" },
  { key: "antigravity",label: "Antigravity",command: "antigravity", icon: "bx-rocket",   color: "#60a5fa", desc: "Antigravity CLI" },
  { key: "codex",      label: "Codex CLI", command: "codex",       icon: "bx-terminal",  color: "#34d399", desc: "OpenAI Codex CLI" },
  { key: "claude",     label: "Claude",    command: "claude",      icon: "bx-bot",       color: "#818cf8", desc: "Anthropic Claude CLI" },
] as const;

type AgentKey = typeof AGENTS[number]["key"];

export const Onboarding: React.FC<OnboardingProps> = ({ onComplete, onCancel }) => {
  const [selectedDir, setSelectedDir] = useState("");
  // Per-agent count (0 = not selected, 1+ = how many terminals)
  const [counts, setCounts] = useState<Record<AgentKey, number>>({
    open_code:   1,  // selected by default
    antigravity: 0,
    codex:       0,
    claude:      0,
  });
  const [skipClaudePerms, setSkipClaudePerms] = useState(true);
  const [customEntries, setCustomEntries] = useState<{ id: number; label: string; command: string; count: number }[]>([]);
  const [nextCustomId, setNextCustomId] = useState(1);

  const pickDir = async () => {
    try {
      const result = await invoke<string | null>("select_directory");
      if (result) setSelectedDir(result);
    } catch {}
  };

  const toggle = (key: AgentKey) => {
    setCounts(prev => ({
      ...prev,
      [key]: prev[key] > 0 ? 0 : 1,
    }));
  };

  const changeCount = (key: AgentKey, delta: number, e: React.MouseEvent) => {
    e.stopPropagation(); // don't toggle when clicking + / -
    setCounts(prev => {
      const otherTotal = AGENTS.reduce((s, a) => s + (a.key === key ? 0 : prev[a.key]), 0);
      const maxAdd = Math.max(0, 16 - otherTotal);
      return {
        ...prev,
        [key]: Math.max(0, Math.min(maxAdd, prev[key] + delta)),
      };
    });
  };

  const addCustomEntry = () => {
    if (totalCount >= 16) return;
    setCustomEntries(prev => [...prev, { id: nextCustomId, label: "", command: "", count: 1 }]);
    setNextCustomId(n => n + 1);
  };

  const updateCustomEntry = (id: number, field: "label" | "command", value: string) => {
    setCustomEntries(prev => prev.map(e => e.id === id ? { ...e, [field]: value } : e));
  };

  const changeCustomCount = (id: number, delta: number) => {
    setCustomEntries(prev => prev.map(e => {
      if (e.id !== id) return e;
      const otherTotal = sessions.length - e.count;
      const max = Math.max(1, 16 - otherTotal);
      return { ...e, count: Math.max(1, Math.min(max, e.count + delta)) };
    }));
  };

  const removeCustomEntry = (id: number) => {
    setCustomEntries(prev => prev.filter(e => e.id !== id));
  };

  // Build flat ordered session list
  const buildSessions = (): AgentSession[] => {
    const list: AgentSession[] = [];
    for (const agent of AGENTS) {
      const n = counts[agent.key];
      for (let i = 0; i < n; i++) {
        const command = agent.key === "claude" && skipClaudePerms ? "claude --dangerously-skip-permissions" : agent.command;
        list.push({ label: agent.label, command });
      }
    }
    for (const entry of customEntries) {
      if (entry.command.trim()) {
        for (let i = 0; i < entry.count; i++) {
          list.push({ label: entry.label.trim() || entry.command.trim(), command: entry.command.trim() });
        }
      }
    }
    return list;
  };

  const sessions = buildSessions();
  const totalCount = sessions.length;
  const canLaunch = !!selectedDir && totalCount > 0;

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card onboarding-single">
        {/* Brand */}
        <div className="onboarding-brand">
          <img src="/logo.png" alt="" className="onboarding-logo" />
          <div>
            <h1 className="onboarding-title">Integraded Workspace</h1>
            <p className="onboarding-subtitle">Configure your environment and launch</p>
          </div>
          {onCancel && (
            <button type="button" className="onboarding-close" onClick={onCancel} title="Cancel">
              <i className="bx bx-x" />
            </button>
          )}
        </div>

        <div className="onboarding-divider" />

        {/* Directory */}
        <section className="ob-section">
          <div className="ob-section-label">
            <i className="bx bx-folder" />
            Workspace Directory
          </div>
          <div className={`dir-picker ${selectedDir ? "chosen" : ""}`} onClick={pickDir}>
            <i className="bx bx-folder-open" />
            <span className="dir-picker-label">{selectedDir || "Click to select workspace directory…"}</span>
            {selectedDir && (
              <span className="dir-picker-badge">{selectedDir.split(/[\\/]/).pop()}</span>
            )}
          </div>
        </section>

        <div className="onboarding-divider" />

        {/* Per-agent counts */}
        <section className="ob-section">
          <div className="ob-section-label">
            <i className="bx bx-bot" />
            Agents &amp; Terminal Count
            <span className="ob-section-hint">click to select · +/- for count</span>
          </div>
          <div className="agent-grid-inline">
            {AGENTS.map(a => {
              const selected = counts[a.key] > 0;
              return (
                <div
                  key={a.key}
                  className={`agent-chip ${selected ? "selected" : ""}`}
                  onClick={() => toggle(a.key)}
                >
                  <i className={`bx ${a.icon}`} style={{ color: a.color }} />
                  <div className="agent-chip-info">
                    <span className="agent-chip-name">{a.label}</span>
                    <span className="agent-chip-desc">{a.desc}</span>
                  </div>

                  {selected && (
                    <div className="agent-chip-counter" onClick={e => e.stopPropagation()}>
                      <button
                        className="agent-count-btn"
                        onClick={e => changeCount(a.key, -1, e)}
                        disabled={counts[a.key] <= 1}
                      >−</button>
                      <span className="agent-count-val">{counts[a.key]}</span>
                      <button
                        className="agent-count-btn"
                        onClick={e => changeCount(a.key, +1, e)}
                        disabled={totalCount >= 16}
                      >+</button>
                    </div>
                  )}

                  {!selected && (
                    <div className="agent-chip-check">
                      {/* empty circle */}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Custom terminals */}
          {customEntries.map(entry => (
            <div key={entry.id} className="ob-custom-entry" onClick={e => e.stopPropagation()}>
              <i className="bx bx-code-curly ob-custom-icon" />
              <input
                className="ob-custom-input"
                type="text"
                placeholder="Label (optional)"
                value={entry.label}
                onChange={e => updateCustomEntry(entry.id, "label", e.target.value)}
              />
              <input
                className="ob-custom-input ob-custom-cmd"
                type="text"
                placeholder="Launch command (e.g. aider)"
                value={entry.command}
                onChange={e => updateCustomEntry(entry.id, "command", e.target.value)}
              />
              <div className="agent-chip-counter ob-custom-counter" onClick={e => e.stopPropagation()}>
                <button
                  className="agent-count-btn"
                  onClick={() => changeCustomCount(entry.id, -1)}
                  disabled={entry.count <= 1}
                >−</button>
                <span className="agent-count-val">{entry.count}</span>
                <button
                  className="agent-count-btn"
                  onClick={() => changeCustomCount(entry.id, +1)}
                  disabled={totalCount >= 16}
                >+</button>
              </div>
              <button className="ob-custom-remove" onClick={() => removeCustomEntry(entry.id)} title="Remove">
                <i className="bx bx-x" />
              </button>
            </div>
          ))}
          <button
            className="ob-add-custom"
            type="button"
            disabled={totalCount >= 16}
            onClick={addCustomEntry}
          >
            <i className="bx bx-plus" /> Add Custom Terminal
          </button>

          {totalCount > 0 && (
            <div className={`ob-total-hint ${totalCount >= 16 ? "ob-total-full" : ""}`}>
              <i className={`bx ${totalCount >= 16 ? "bxs-error" : "bx-grid-alt"}`} />
              {totalCount} / 16 terminal{totalCount !== 1 ? "s" : ""}
              {totalCount >= 16 && " (max reached)"}
              {" — "}
              {sessions.map(s => s.label).join(", ")}
            </div>
          )}

          {counts.claude > 0 && (
            <label className="ob-claude-skip" onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={skipClaudePerms}
                onChange={e => setSkipClaudePerms(e.target.checked)}
              />
              <span>
                Skip permissions <code>--dangerously-skip-permissions</code>
              </span>
            </label>
          )}
        </section>

        <div className="onboarding-divider" />

        {/* Launch */}
        <div className="ob-footer">
          <div className="ob-footer-hint">
            {!selectedDir && <span className="ob-warn"><i className="bx bx-error-circle" /> Select a directory</span>}
            {selectedDir && totalCount === 0 && <span className="ob-warn"><i className="bx bx-error-circle" /> Select at least one agent</span>}
            {canLaunch && <span className="ob-ready"><i className="bx bx-check-circle" /> Ready to launch</span>}
          </div>
          <button
            className="btn btn-primary btn-launch"
            disabled={!canLaunch}
            onClick={() => onComplete({ directory: selectedDir, sessions })}
          >
            <i className="bx bx-play" />
            Launch Workspace
          </button>
        </div>
      </div>
    </div>
  );
};
