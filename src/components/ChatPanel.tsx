import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Msg {
  id: string;
  role: "ai" | "user";
  body: string;
  ts: string;
  thinking?: string;
  agent?: "planning" | "build" | "system";
  commands?: { sessionId: string; label: string; cmd: string; approved?: boolean }[];
}

export interface Session {
  id: number;
  sessionId: string;
  label: string;
  command: string;
}

export const ChatPanel: React.FC<{
  width?: number;
  embedded?: boolean;
  sessions?: Session[];
  onSendPtyCommand?: (sessId: string, cmd: string) => void;
  onAddSession?: (label: string, command: string) => void;
}> = ({
  width,
  embedded,
  sessions = [],
  onSendPtyCommand,
  onAddSession,
}) => {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  
  // LLM Config & Settings
  const [config, setConfig] = useState<any>(null);
  const [models, setModels] = useState<string[]>(["Claude-3.5-Sonnet (Simulated)"]);
  const [selectedModel, setSelectedModel] = useState<string>("Claude-3.5-Sonnet (Simulated)");
  const [isServerOnline, setIsServerOnline] = useState(false);
  
  // Permission Mode (Segmented controls)
  const [consentMode, setConsentMode] = useState(true); // true = Consent required, false = Auto-execute

  // Custom Dropdown Open State
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);

  const endRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  // Click outside model dropdown
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    if (modelDropdownOpen) {
      window.addEventListener("mousedown", handleOutsideClick);
    }
    return () => {
      window.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [modelDropdownOpen]);

  // ── Load Workspace Configuration ──────────────────────────────────────────
  const loadWorkspaceConfig = async () => {
    try {
      const loaded = await invoke<any>("load_config");
      setConfig(loaded);
    } catch (err) {
      console.error("Failed to load workspace config in chat:", err);
    }
  };

  useEffect(() => {
    loadWorkspaceConfig();
    window.addEventListener("__integradedConfigUpdated", loadWorkspaceConfig);
    return () => {
      window.removeEventListener("__integradedConfigUpdated", loadWorkspaceConfig);
    };
  }, []);

  // ── Poll for active LLM models via backend proxy ──────────────────────────
  useEffect(() => {
    if (!config) return;

    const checkModels = async () => {
      const provider = config.provider || "cloud";

      if (provider === "lmstudio") {
        try {
          let baseUrl = config.lmstudio_url || "http://localhost:1234";
          if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
          const url = `${baseUrl}/v1/models`;

          const resStr = await invoke<string>("curl_get", { url });
          const data = JSON.parse(resStr);
          const names = data.data.map((m: any) => m.id);
          if (names && names.length > 0) {
            setModels(names);
            setIsServerOnline(true);
            if (!names.includes(selectedModel)) {
              setSelectedModel(names[0]);
            }
          } else {
            setModels(["LM Studio Default"]);
            setSelectedModel("LM Studio Default");
            setIsServerOnline(true);
          }
        } catch {
          setIsServerOnline(false);
          setModels(["LM Studio Offline"]);
          setSelectedModel("LM Studio Offline");
        }
      } else if (provider === "ollama") {
        try {
          let baseUrl = config.ollama_url || "http://localhost:11434";
          if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
          const url = `${baseUrl}/api/tags`;

          const resStr = await invoke<string>("curl_get", { url });
          const data = JSON.parse(resStr);
          const names = data.models.map((m: any) => m.name);
          if (names && names.length > 0) {
            setModels(names);
            setIsServerOnline(true);
            if (!names.includes(selectedModel)) {
              setSelectedModel(names[0]);
            }
          } else {
            setModels(["Ollama Default"]);
            setSelectedModel("Ollama Default");
            setIsServerOnline(true);
          }
        } catch {
          setIsServerOnline(false);
          setModels(["Ollama Offline"]);
          setSelectedModel("Ollama Offline");
        }
      } else {
        // Cloud Provider
        setIsServerOnline(true);
        const cProv = config.cloud_provider || "openai";
        let defaultModels: string[] = [];
        if (cProv === "openai") {
          defaultModels = ["gpt-4o", "gpt-4o-mini", "o1-mini"];
        } else if (cProv === "anthropic") {
          defaultModels = ["claude-3-5-sonnet", "claude-3-5-haiku", "claude-3-opus"];
        } else if (cProv === "deepseek") {
          defaultModels = ["deepseek-chat", "deepseek-reasoner"];
        } else {
          defaultModels = ["Claude-3.5-Sonnet (Simulated)"];
        }
        setModels(defaultModels);
        if (!defaultModels.includes(selectedModel)) {
          setSelectedModel(defaultModels[0]);
        }
      }
    };

    checkModels();
    const timer = setInterval(checkModels, 5000);
    return () => clearInterval(timer);
  }, [config, selectedModel]);

  // ── Speech-To-Text Dictation (Auto Language Detection) ───────────────────
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = false;
      
      // Auto-detect spoken language using standard system and browser locale
      rec.lang = navigator.language || "cs-CZ";
      
      rec.onstart = () => setIsRecording(true);
      rec.onerror = () => setIsRecording(false);
      rec.onend = () => setIsRecording(false);
      rec.onresult = (e: any) => {
        const text = e.results[0][0].transcript;
        setInput(prev => prev + (prev ? " " : "") + text);
      };
      
      recognitionRef.current = rec;
    }
  }, []);

  const toggleRecording = () => {
    const rec = recognitionRef.current;
    if (!rec) {
      alert("Speech recognition is not supported in this browser/system.");
      return;
    }
    if (isRecording) {
      rec.stop();
    } else {
      rec.lang = navigator.language || "cs-CZ";
      rec.start();
    }
  };

  const ts = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // ── Send chat input to Coordinator Agent ────────────────────────────────────
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;

    // 1. Add User Message
    const userMsg: Msg = { id: `u-${Date.now()}`, role: "user", body: text, ts: ts() };
    setMsgs(p => [...p, userMsg]);
    setInput("");

    // 2. Spawn Double-Agent (Planning -> Build) flow
    setTimeout(() => {
      const lower = text.toLowerCase();
      
      // Determine what active PTY sessions exist
      const activeSessions = sessions;
      
      // Look up target session based on query
      let targetSession = activeSessions[0];
      if (lower.includes("opencode")) {
        targetSession = activeSessions.find(s => s.label.toLowerCase().includes("opencode")) || targetSession;
      } else if (lower.includes("claude")) {
        targetSession = activeSessions.find(s => s.label.toLowerCase().includes("claude")) || targetSession;
      } else if (lower.includes("antigravity")) {
        targetSession = activeSessions.find(s => s.label.toLowerCase().includes("antigravity")) || targetSession;
      }

      // Planning Agent thoughts
      let planThinking = `Analyzing workspace directory and active terminals.\nFound ${activeSessions.length} active terminal sessions.\nFormulating parallel execution plan...`;
      let planBody = "";
      let commandsToRun: { sessionId: string; label: string; cmd: string }[] = [];

      // Determine task delegation logic
      if (lower.includes("spust") || lower.includes("spawn") || lower.includes("otevři") || lower.includes("open")) {
        if (lower.includes("opencode") || lower.includes("open code")) {
          planBody = `**[Planning Agent Plan]**\nDetecting need for new CLI environments. Adding a new **opencode** terminal panel dynamically.`;
          commandsToRun = [{ sessionId: "new", label: "opencode", cmd: "opencode" }];
        } else if (lower.includes("claude")) {
          planBody = `**[Planning Agent Plan]**\nDetecting request for Claude. Spawning a new **Claude** session.`;
          commandsToRun = [{ sessionId: "new", label: "Claude", cmd: "claude" }];
        } else {
          planBody = `**[Planning Agent Plan]**\nAdding a standard fallback shell terminal session.`;
          commandsToRun = [{ sessionId: "new", label: "Shell", cmd: "shell" }];
        }
      } else if (lower.includes("build") || lower.includes("run build") || lower.includes("zkompiluj")) {
        planBody = `**[Planning Agent Plan]**\nTask: Compile the codebase.\n1. Dispatching \`npm run build\` to the primary shell session (${targetSession?.label || "shell"}).\n2. Monitoring stdout diagnostics.`;
        if (targetSession) {
          commandsToRun = [{ sessionId: targetSession.sessionId, label: targetSession.label, cmd: "npm run build" }];
        }
      } else if (lower.includes("test") || lower.includes("spusť testy")) {
        planBody = `**[Planning Agent Plan]**\nTask: Execute test suite.\n1. Dispatching test execution to active terminal session (${targetSession?.label || "shell"}).\n2. Parsing diagnostics output.`;
        if (targetSession) {
          commandsToRun = [{ sessionId: targetSession.sessionId, label: targetSession.label, cmd: "npm test" }];
        }
      } else {
        planBody = `**[Planning Agent Plan]**\nTask: Generic command delegation.\n1. Dispatching inquiry command to active session (${targetSession?.label || "shell"}).`;
        if (targetSession) {
          commandsToRun = [{ sessionId: targetSession.sessionId, label: targetSession.label, cmd: "echo 'Integraded Agent orchestrator active!'" }];
        }
      }

      // Add Planning Agent msg
      const planMsgId = `p-${Date.now()}`;
      setMsgs(p => [...p, {
        id: planMsgId,
        role: "ai",
        agent: "planning",
        body: planBody,
        thinking: planThinking,
        ts: ts(),
      }]);

      // Trigger Build Agent flow 1.2s later
      setTimeout(() => {
        let buildThinking = `PTY injection protocol initialized.\nVerifying session handles...\nRouting commands to terminal panels.`;
        let buildBody = "";

        if (commandsToRun.length > 0) {
          if (consentMode) {
            buildBody = `**[Build Agent Execution Queue]**\nThe Planning plan requires executing CLI actions. Since **Consent Mode** is enabled, please approve the actions below to dispatch them into your terminal grid:`;
          } else {
            buildBody = `**[Build Agent Execution Queue]**\n**Auto-Execute Mode** active. Auto-dispatched the following actions directly into the active PTY terminals:`;
            // Execute automatically
            commandsToRun.forEach(c => {
              if (c.sessionId === "new") {
                if (onAddSession) {
                  onAddSession(c.label, c.cmd);
                }
              } else {
                if (onSendPtyCommand) {
                  onSendPtyCommand(c.sessionId, c.cmd);
                }
              }
            });
          }
        } else {
          buildBody = `**[Build Agent Diagnostics]**\nAll operations resolved successfully. No additional PTY inputs required in active panels.`;
        }

        setMsgs(p => [...p, {
          id: `b-${Date.now()}`,
          role: "ai",
          agent: "build",
          body: buildBody,
          thinking: buildThinking,
          commands: commandsToRun,
          ts: ts(),
        }]);

      }, 1200);

    }, 800);
  };

  // ── Approve and dispatch PTY command manually ──────────────────────────────
  const approveCommand = (msgId: string, cmdIndex: number, cmd: { sessionId: string; label: string; cmd: string }) => {
    if (cmd.sessionId === "new") {
      if (onAddSession) {
        onAddSession(cmd.label, cmd.cmd);
      }
    } else {
      if (onSendPtyCommand) {
        onSendPtyCommand(cmd.sessionId, cmd.cmd);
      }
    }

    setMsgs(p => p.map(m => {
      if (m.id === msgId && m.commands) {
        const updatedCmds = [...m.commands];
        updatedCmds[cmdIndex] = { ...updatedCmds[cmdIndex], approved: true };
        return { ...m, commands: updatedCmds };
      }
      return m;
    }));
  };

  return (
    <div className={`chat-panel ${embedded ? "embedded" : ""}`} style={embedded ? {} : { width }}>
      {/* ── Chat Messages ── */}
      <div className="chat-messages">
        {msgs.length === 0 ? (
          <div className="chat-empty-state">
            <i className="bx bx-message-square-detail" />
            <span className="chat-empty-label">No messages</span>
            <span className="chat-empty-sub">
              Command your terminal agents using local models or speech.
            </span>
          </div>
        ) : msgs.map((m) => {
          const isUser = m.role === "user";
          let agentBadge = "";
          if (m.agent === "planning") agentBadge = "Planning Agent";
          if (m.agent === "build") agentBadge = "Build Agent";

          return (
            <div key={m.id} className="chat-msg">
              <div className="chat-msg-meta">
                <span className={`chat-avatar ${isUser ? "user" : "ai"}`}>
                  <i className={`bx bx-${isUser ? "user" : m.agent === "planning" ? "network-chart" : "bot"}`} />
                </span>
                <span className="chat-sender">
                  {isUser ? "You" : agentBadge || "Coordinator"}
                </span>
                <span className="chat-ts">{m.ts}</span>
              </div>

              {m.thinking && (
                <details className="chat-thinking-box" open>
                  <summary className="chat-thinking-summary">
                    <i className="bx bx-brain bx-spin" /> Thinking process...
                  </summary>
                  <div className="chat-thinking-content">{m.thinking}</div>
                </details>
              )}

              <div className={`chat-bubble ${isUser ? "user" : "ai"}`}>
                <div>
                  {m.body.split('\n').map((line, idx) => (
                    <React.Fragment key={idx}>
                      {line}
                      {idx < m.body.split('\n').length - 1 && <br />}
                    </React.Fragment>
                  ))}
                </div>

                {m.commands && m.commands.length > 0 && (
                  <div className="chat-commands-block">
                    {m.commands.map((c, index) => (
                      <div key={index} className="chat-cmd-row">
                        <code className="chat-cmd-code">
                          {c.sessionId === "new" ? "New terminal" : c.label} {">"} {c.cmd}
                        </code>
                        <button
                          className={`btn btn-sm ${c.approved ? "btn-ghost text-ok" : "btn-primary"}`}
                          disabled={c.approved}
                          onClick={() => approveCommand(m.id, index, c)}
                        >
                          {c.approved ? (
                            <>
                              <i className="bx bx-check-double" /> Approved
                            </>
                          ) : (
                            <>
                              <i className="bx bx-play-circle" /> Approve & Run
                            </>
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {/* ── Execution Mode Toggle Ribbon (Segmented Control Above Composer) ── */}
      <div className="chat-mode-selector-ribbon">
        <span className="chat-mode-label">Execution:</span>
        <div className="chat-mode-toggle-group">
          <button
            type="button"
            className={`chat-mode-btn ${consentMode ? "active" : ""}`}
            onClick={() => setConsentMode(true)}
            title="Require manual consent before running any CLI actions"
          >
            <i className="bx bx-shield-quarter" />
            <span>Consent</span>
          </button>
          <button
            type="button"
            className={`chat-mode-btn ${!consentMode ? "active" : ""}`}
            onClick={() => setConsentMode(false)}
            title="Automatically execute all planned CLI actions in terminal panels"
          >
            <i className="bx bx-bolt-circle" />
            <span>Auto-Run</span>
          </button>
        </div>
      </div>

      {/* ── Rich Bottom Chat Composer ── */}
      <form className="chat-composer" onSubmit={send}>
        {/* Microphone STT Button */}
        <button
          type="button"
          className={`chat-composer-btn mic-btn ${isRecording ? "recording" : ""}`}
          onClick={toggleRecording}
          title={isRecording ? "Stop dictation" : "Start voice dictation (Auto Language Detection)"}
        >
          <i className={`bx bx-microphone${isRecording ? "-off" : ""}`} />
        </button>

        {/* Premium Custom Model Dropdown Selection (Upwards expansion) */}
        <div className="chat-composer-model-pill" ref={modelDropdownRef}>
          <button
            type="button"
            className="chat-composer-model-trigger"
            onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
            title="Select LLM model"
          >
            <i className="bx bx-chip" />
            <span className="chat-composer-model-name">{selectedModel}</span>
            <span className={`chat-status-dot ${isServerOnline ? "online" : "offline"}`} style={{ marginLeft: 4, width: 6, height: 6 }} />
            <i className={`bx bx-chevron-up ${modelDropdownOpen ? "open" : ""}`} />
          </button>
          {modelDropdownOpen && (
            <div className="chat-composer-model-dropdown">
              {models.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`chat-composer-model-item ${m === selectedModel ? "active" : ""}`}
                  onClick={() => {
                    setSelectedModel(m);
                    setModelDropdownOpen(false);
                  }}
                >
                  <span className="chat-composer-model-item-text">{m}</span>
                  {m === selectedModel && <i className="bx bx-check" />}
                </button>
              ))}
            </div>
          )}
        </div>

        <input
          className="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={isRecording ? "Listening..." : "Ask something…"}
          autoComplete="off"
          spellCheck={false}
          disabled={isRecording}
        />

        <button type="submit" className="chat-send-btn">
          <i className="bx bx-send" />
        </button>
      </form>
    </div>
  );
};
