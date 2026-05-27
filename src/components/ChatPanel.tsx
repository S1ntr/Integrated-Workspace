import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useNotify } from "./Notification";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Session {
  id: number;
  sessionId: string;
  label: string;
  command: string;
  status?: "booting" | "running" | "exited";
}

interface AgentAction {
  type: "spawn" | "send" | "kill";
  agentType?: string;
  label: string;
  prompt?: string;
}

interface Msg {
  id: string;
  role: "ai" | "user";
  body: string;
  ts: string;
  streaming?: boolean;
  agent?: "orchestrator" | "system";
  actions?: AgentAction[];
}

interface ChatHistory {
  id: string;
  name: string;
  msgs: Msg[];
  createdAt: number;
}

interface ModelEntry {
  value: string;
  label?: string;
  provider: string;
  providerName: string;
  type: "cloud" | "local";
}

// ─── Constants ────────────────────────────────────────────────────────────────

const QUICK_AGENTS = [
  { label: "Shell",       command: "shell",       icon: "bx-terminal" },
  { label: "Claude",      command: "claude",       icon: "bx-bot" },
  { label: "opencode",    command: "opencode",     icon: "bx-code-alt" },
  { label: "Codex",       command: "codex",        icon: "bx-terminal" },
  { label: "Antigravity", command: "antigravity",  icon: "bx-rocket" },
];

const CLOUD_MODELS: Record<string, { value: string; label: string }[]> = {
  openai: [
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-4o-mini", label: "GPT-4o Mini" },
    { value: "o1", label: "o1" },
    { value: "o3-mini", label: "o3 Mini" },
  ],
  anthropic: [
    { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
  ],
  deepseek: [
    { value: "deepseek-chat", label: "DeepSeek V3" },
    { value: "deepseek-reasoner", label: "DeepSeek R1" },
  ],
  mistral: [
    { value: "mistral-large-2501", label: "Mistral Large" },
    { value: "codestral-2501", label: "Codestral" },
  ],
  google: [
    { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    { value: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
  ],
  grok: [
    { value: "grok-3", label: "Grok 3" },
    { value: "grok-3-mini", label: "Grok 3 Mini" },
  ],
  together: [
    { value: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B" },
    { value: "deepseek-ai/DeepSeek-V3", label: "DeepSeek V3" },
  ],
  openrouter: [
    { value: "openai/gpt-4o", label: "GPT-4o" },
    { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "google/gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  ],
};

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic", deepseek: "DeepSeek",
  mistral: "Mistral", google: "Google", grok: "Grok",
  together: "Together AI", openrouter: "OpenRouter",
};

// ─── Markdown helpers ─────────────────────────────────────────────────────────

function formatInline(line: string): React.ReactNode[] {
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`[^`]+`)/g;
  const parts: React.ReactNode[] = [];
  let last = 0, match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > last) parts.push(line.slice(last, match.index));
    if (match[1]) parts.push(<strong key={`b${last}`}>{match[2]}</strong>);
    else if (match[3]) parts.push(<em key={`i${last}`}>{match[4]}</em>);
    else parts.push(<code key={`c${last}`} className="chat-inline-code">{match[0].slice(1,-1)}</code>);
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts.length ? parts : [line];
}

function formatBody(body: string): React.ReactNode {
  const lines = body.split("\n").filter(l => !/^\[AGENT:(spawn|send|kill):/.test(l.trim()));
  const els: React.ReactNode[] = [];
  let inCode = false, codeBuf: string[] = [], codeLang = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (inCode) {
        els.push(<pre key={`cb${i}`} className="chat-code-block">{codeLang && <div className="chat-code-lang">{codeLang}</div>}<code>{codeBuf.join("\n")}</code></pre>);
        codeBuf = []; inCode = false; codeLang = "";
      } else { inCode = true; codeLang = line.slice(3).trim(); }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const t = line.trim();
    if (!t) { els.push(<br key={`br${i}`} />); continue; }
    if (line.startsWith("## "))       els.push(<div key={`h${i}`}  className="chat-heading">{formatInline(line.slice(3))}</div>);
    else if (line.startsWith("### ")) els.push(<div key={`h3${i}`} className="chat-heading chat-heading-3">{formatInline(line.slice(4))}</div>);
    else if (line.startsWith("> "))   els.push(<div key={`q${i}`}  className="chat-blockquote">{formatInline(line.slice(2))}</div>);
    else if (/^---/.test(line))       els.push(<hr  key={`hr${i}`} className="chat-hr" />);
    else if (/^[-*] /.test(line))     els.push(<div key={`li${i}`} className="chat-list-item">{formatInline(line.slice(2))}</div>);
    else if (/^\d+\. /.test(line))    els.push(<div key={`li${i}`} className="chat-list-item">{formatInline(line.replace(/^\d+\. /,""))}</div>);
    else                              els.push(<div key={`l${i}`}  className="chat-line">{formatInline(line)}</div>);
  }
  if (inCode) els.push(<pre key="cbf" className="chat-code-block"><code>{codeBuf.join("\n")}</code></pre>);
  return <>{els}</>;
}

// ─── SSE parser ───────────────────────────────────────────────────────────────

function parseStreamDelta(line: string, provider: string): string | null {
  if (!line.trim()) return null;
  if (provider === "ollama") {
    try { const d = JSON.parse(line); return d.response || d.message?.content || null; } catch { return null; }
  }
  if (provider === "anthropic") {
    try { const d = JSON.parse(line); return d.type === "content_block_delta" ? d.delta?.text || null : null; } catch { return null; }
  }
  if (line.startsWith("data: ")) {
    const j = line.slice(6).trim();
    if (j === "[DONE]") return null;
    try { const d = JSON.parse(j); return d.choices?.[0]?.delta?.content || null; } catch { return null; }
  }
  return null;
}

// ─── Agent action parser ──────────────────────────────────────────────────────

function parseAgentActions(text: string): AgentAction[] {
  const actions: AgentAction[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    const spawn = t.match(/^\[AGENT:spawn:([^:]+):([^\]]+)\]\s*([\s\S]*)/);
    if (spawn) { actions.push({ type:"spawn", agentType: spawn[1].trim().toLowerCase(), label: spawn[2].trim(), prompt: spawn[3].trim() }); continue; }
    const send = t.match(/^\[AGENT:send:([^\]]+)\]\s*([\s\S]*)/);
    if (send) { actions.push({ type:"send", label: send[1].trim(), prompt: send[2].trim() }); continue; }
    const kill = t.match(/^\[AGENT:kill:([^\]]+)\]/);
    if (kill) actions.push({ type:"kill", label: kill[1].trim() });
  }
  return actions;
}

function stripAgentTags(text: string): string {
  return text.split("\n").filter(l => !/^\[AGENT:(spawn|send|kill):/.test(l.trim())).join("\n").trim();
}

// ─── Orchestrator system prompt ───────────────────────────────────────────────

function buildOrchestratorPrompt(sessions: Session[], outputs: Record<string, string>): string {
  const sessionList = sessions.length > 0
    ? sessions.map(s => `- ${s.label} (${s.command})`).join("\n")
    : "(none — use spawn actions to create terminals)";

  const outputBlocks = sessions
    .filter(s => outputs[s.sessionId]?.trim())
    .map(s => `### ${s.label}\n\`\`\`\n${(outputs[s.sessionId]||"").slice(-800).trim()}\n\`\`\``)
    .join("\n\n");

  return `You are the **Orchestrator** in "Integraded" — an integrated multi-agent development workspace.

## Role
Break user requests into parallel sub-tasks. Dispatch each to a dedicated CLI coding agent in a real terminal. Ensure all agents produce compatible, integrating work.

## Active Sessions
${sessionList}

## Available Agent Types
- \`claude\` — Anthropic Claude CLI (complex coding, architecture)
- \`opencode\` — opencode.ai (fast, focused file tasks)
- \`codex\` — OpenAI Codex CLI
- \`shell\` — PowerShell/bash (commands, installs, scripts)
- \`antigravity\` — Antigravity CLI

## Tool Actions — execute automatically, hidden from UI
\`[AGENT:spawn:agenttype:Label]\` Prompt
→ Opens new terminal with that agent type, sends prompt after 2.5s startup

\`[AGENT:send:Label]\` Message
→ Sends follow-up to existing session

\`[AGENT:kill:Label]\`
→ Terminates session

## Coordination Rules
1. **REUSE ACTIVE SESSIONS**: ALWAYS prefer sending tasks to already active sessions. If a running active session (e.g. "HTML Builder" or "CSS Stylist") listed under "Active Sessions" above can handle the task, you MUST use \`[AGENT:send:Label]\` to send the prompt to it. DO NOT spawn a new session using \`[AGENT:spawn:...\` if a matching/compatible session already exists.
2. Unique descriptive labels: "HTML Builder", "CSS Stylist", "JS Developer", etc.
3. Each agent gets ONE focused task with FULL context: file names, shared types, conventions
4. Never assign two agents to the same file
5. If agent A defines a shared type, paste the full definition into agent B's prompt
6. After dispatching, briefly summarize what each agent is building (visible to user)

## Current Agent Output
${outputBlocks || "(no output captured yet)"}`;
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── ChatPanel ────────────────────────────────────────────────────────────────

export const ChatPanel: React.FC<{
  embedded?: boolean;
  sessions?: Session[];
  terminalOutputs?: Record<string, string>;
  onSendPtyCommand?: (sessId: string, cmd: string) => void;
  onAddSession?: (label: string, command: string) => Session;
  onCloseSession?: (id: number) => void;
  onRestartSession?: (id: number) => string;
}> = ({
  embedded,
  sessions: sessionsProp = [],
  terminalOutputs: terminalOutputsProp = {},
  onSendPtyCommand,
  onAddSession,
  onCloseSession,
  onRestartSession,
}) => {
  // ── Core state ───────────────────────────────────────────────────────────────
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try {
      const stored = localStorage.getItem("integraded_chat_current_msgs");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  // ── Chat history ─────────────────────────────────────────────────────────────
  const [histories, setHistories] = useState<ChatHistory[]>(() => {
    try {
      const stored = localStorage.getItem("integraded_chat_histories");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);

  // ── Terminal picker ──────────────────────────────────────────────────────────
  const [termPickerOpen, setTermPickerOpen] = useState(false);
  const termPickerRef = useRef<HTMLDivElement>(null);

  // ── Model selection ──────────────────────────────────────────────────────────
  const [config, setConfig] = useState<any>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedCloudProvider, setSelectedCloudProvider] = useState("openai");
  const [streamingEnabled, setStreamingEnabled] = useState(true);
  const [modelSearch, setModelSearch] = useState("");
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const pillBtnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{top:number;left:number} | null>(null);

  // ── Refs ─────────────────────────────────────────────────────────────────────
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<any>(null);
  const streamUnlistenRef = useRef<(() => void) | null>(null);
  const streamTextRef = useRef("");
  const activeStreamIdRef = useRef<string | null>(null);

  const onSendPtyCommandRef = useRef(onSendPtyCommand);
  const onAddSessionRef = useRef(onAddSession);
  const onCloseSessionRef = useRef(onCloseSession);
  const onRestartSessionRef = useRef(onRestartSession);
  const sessionsRef = useRef(sessionsProp);
  const terminalOutputsRef = useRef(terminalOutputsProp);
  const loadingHomeHistory = useRef(true);
  
  onSendPtyCommandRef.current = onSendPtyCommand;
  onAddSessionRef.current = onAddSession;
  onCloseSessionRef.current = onCloseSession;
  onRestartSessionRef.current = onRestartSession;
  sessionsRef.current = sessionsProp;
  terminalOutputsRef.current = terminalOutputsProp;

  // ── Effects ──────────────────────────────────────────────────────────────────

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 180) + "px"; }
  }, [input]);

  // Close dropdowns on outside click
  useEffect(() => {
    const fn = (e: MouseEvent) => {
      // Model dropdown: check both the pill wrapper and the fixed dropdown itself
      // The fixed dropdown has a data attribute to identify it
      const target = e.target as Node;
      const inPill = modelDropdownRef.current?.contains(target);
      const inDropdown = (target as Element)?.closest?.('[data-model-dropdown]');
      if (!inPill && !inDropdown) setModelDropdownOpen(false);

      if (historyRef.current && !historyRef.current.contains(target)) setHistoryOpen(false);
      if (termPickerRef.current && !termPickerRef.current.contains(target)) setTermPickerOpen(false);
    };
    window.addEventListener("mousedown", fn);
    return () => window.removeEventListener("mousedown", fn);
  }, []);

  // Load config
  const loadConfig = async () => {
    try {
      const loaded = await invoke<any>("load_config");
      setConfig(loaded);
      setStreamingEnabled(loaded.streaming ?? true);
      if (loaded.cloud_provider) setSelectedCloudProvider(loaded.cloud_provider);
    } catch {}
  };
  useEffect(() => {
    loadConfig();
    window.addEventListener("__integradedConfigUpdated", loadConfig);
    return () => window.removeEventListener("__integradedConfigUpdated", loadConfig);
  }, []);

  // Load chat histories from home directory file on mount
  useEffect(() => {
    (async () => {
      try {
        const data = await invoke<string | null>("load_chat_history");
        if (data) {
          const parsed = JSON.parse(data);
          if (parsed.current_msgs) {
            setMsgs(parsed.current_msgs);
            localStorage.setItem("integraded_chat_current_msgs", JSON.stringify(parsed.current_msgs));
          }
          if (parsed.histories) {
            setHistories(parsed.histories);
            localStorage.setItem("integraded_chat_histories", JSON.stringify(parsed.histories));
          }
        }
      } catch (e) {
        console.error("Failed to load chat history from home directory:", e);
      } finally {
        loadingHomeHistory.current = false;
      }
    })();
  }, []);

  // Persistence synchronizations
  useEffect(() => {
    try {
      localStorage.setItem("integraded_chat_current_msgs", JSON.stringify(msgs));
    } catch {}
    if (!loadingHomeHistory.current) {
      const payload = JSON.stringify({ current_msgs: msgs, histories });
      invoke("save_chat_history", { jsonData: payload }).catch(() => {});
    }
  }, [msgs]);

  useEffect(() => {
    try {
      localStorage.setItem("integraded_chat_histories", JSON.stringify(histories));
    } catch {}
    if (!loadingHomeHistory.current) {
      const payload = JSON.stringify({ current_msgs: msgs, histories });
      invoke("save_chat_history", { jsonData: payload }).catch(() => {});
    }
  }, [histories]);

  useEffect(() => {
    const handleClear = () => {
      setMsgs([]);
      setHistories([]);
    };
    window.addEventListener("__integradedChatHistoryCleared", handleClear);
    return () => window.removeEventListener("__integradedChatHistoryCleared", handleClear);
  }, []);

  // Poll models
  useEffect(() => {
    if (!config) return;
    const check = async () => {
      const result: ModelEntry[] = [];
      const keys = config.api_keys || {};
      for (const [prov, mods] of Object.entries(CLOUD_MODELS)) {
        if (keys[prov] && (keys[prov] as string).length > 5) {
          for (const m of mods) result.push({ value: m.value, label: m.label, provider: prov, providerName: PROVIDER_NAMES[prov], type: "cloud" });
        }
      }
      try {
        const lmUrl = (config.lmstudio_url || "http://localhost:1234").replace(/\/+$/, "");
        const d = JSON.parse(await invoke<string>("curl_get", { url: `${lmUrl}/v1/models` }));
        for (const m of d.data) result.push({ value: m.id, provider: "lmstudio", providerName: "LM Studio", type: "local" });
      } catch {}
      try {
        const olUrl = (config.ollama_url || "http://localhost:11434").replace(/\/+$/, "");
        const d = JSON.parse(await invoke<string>("curl_get", { url: `${olUrl}/api/tags` }));
        for (const m of d.models) result.push({ value: m.name, provider: "ollama", providerName: "Ollama", type: "local" });
      } catch {}
      setModels(result);
      if (!result.some(m => m.value === selectedModel) && result.length > 0) {
        setSelectedModel(result[0].value);
        setSelectedCloudProvider(result[0].provider);
      }
    };
    check();
    const t = setInterval(check, 8000);
    return () => clearInterval(t);
  }, [config]);

  // Speech recognition
  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.continuous = false; rec.interimResults = false; rec.lang = navigator.language || "cs-CZ";
    rec.onstart = () => setIsRecording(true);
    rec.onerror = () => setIsRecording(false);
    rec.onend = () => setIsRecording(false);
    rec.onresult = (e: any) => setInput(p => p + (p ? " " : "") + e.results[0][0].transcript);
    recognitionRef.current = rec;
  }, []);

  const { notifyError } = useNotify();

  const toggleRecording = () => {
    const rec = recognitionRef.current;
    if (!rec) { notifyError("Speech recognition not supported."); return; }
    if (isRecording) rec.stop(); else { rec.lang = navigator.language || "cs-CZ"; rec.start(); }
  };

  const ts = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // ── Chat history management ───────────────────────────────────────────────────

  const saveAndNewChat = () => {
    if (msgs.length > 0) {
      const name = msgs.find(m => m.role === "user")?.body.slice(0, 60) || "Chat";
      setHistories(prev => [{ id: `h${Date.now()}`, name, msgs: [...msgs], createdAt: Date.now() }, ...prev]);
    }
    setMsgs([]);
    setHistoryOpen(false);
  };

  const loadHistory = (h: ChatHistory) => {
    if (msgs.length > 0) {
      const name = msgs.find(m => m.role === "user")?.body.slice(0, 60) || "Chat";
      setHistories(prev => [
        { id: `h${Date.now()}`, name, msgs: [...msgs], createdAt: Date.now() },
        ...prev.filter(x => x.id !== h.id),
      ]);
    } else {
      setHistories(prev => prev.filter(x => x.id !== h.id));
    }
    setMsgs(h.msgs);
    setHistoryOpen(false);
  };

  const deleteHistory = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setHistories(prev => prev.filter(h => h.id !== id));
  };

  // ── Build API request ─────────────────────────────────────────────────────────

  const buildRequest = (messages: { role: string; content: string }[], streaming: boolean) => {
    if (!config) throw new Error("No configuration loaded.");
    const model = selectedModel || "gpt-4o";
    const entry = models.find(m => m.value === model);
    const provType = entry?.type || "cloud";
    const provName = entry?.provider || "openai";

    if (provType === "local" && provName === "lmstudio") {
      const base = (config.lmstudio_url || "http://localhost:1234").replace(/\/+$/, "");
      return { provider: "lmstudio", url: `${base}/v1/chat/completions`, body: JSON.stringify({ model, messages, stream: streaming }), headers: [["Content-Type","application/json"]] as string[][] };
    }
    if (provType === "local" && provName === "ollama") {
      const base = (config.ollama_url || "http://localhost:11434").replace(/\/+$/, "");
      return { provider: "ollama", url: `${base}/api/chat`, body: JSON.stringify({ model, messages, stream: streaming }), headers: [["Content-Type","application/json"]] as string[][] };
    }

    const prov = selectedCloudProvider || config.cloud_provider || "openai";
    const key = config.api_keys?.[prov] || "";
    if (!key) throw new Error(`No API key for ${prov}.`);

    if (prov === "anthropic") {
      const aMessages = messages.filter(m => m.role !== "system").map(m => ({ role: m.role as "user"|"assistant", content: m.content }));
      const sys = messages.find(m => m.role === "system");
      const body: any = { model, max_tokens: 4096, messages: aMessages };
      if (streaming) body.stream = true;
      if (sys) body.system = sys.content;
      return { provider: "anthropic", url: "https://api.anthropic.com/v1/messages", body: JSON.stringify(body), headers: [["x-api-key",key],["anthropic-version","2023-06-01"],["Content-Type","application/json"]] as string[][] };
    }

    const URLS: Record<string,string> = {
      openai: "https://api.openai.com/v1/chat/completions",
      deepseek: "https://api.deepseek.com/chat/completions",
      mistral: "https://api.mistral.ai/v1/chat/completions",
      google: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      grok: "https://api.x.ai/v1/chat/completions",
      together: "https://api.together.xyz/v1/chat/completions",
      openrouter: "https://openrouter.ai/api/v1/chat/completions",
    };
    const url = URLS[prov] || URLS.openai;
    if (prov === "google") {
      return { provider: prov, url: `${url}?key=${key}`, body: JSON.stringify({ model, messages, max_tokens: 4096, stream: streaming }), headers: [["Content-Type","application/json"]] as string[][] };
    }
    return { provider: prov, url, body: JSON.stringify({ model, messages, max_tokens: 4096, stream: streaming }), headers: [["Authorization",`Bearer ${key}`],["Content-Type","application/json"]] as string[][] };
  };

  // ── Streaming ─────────────────────────────────────────────────────────────────

  const streamLLM = async (msgId: string, messages: { role: string; content: string }[]) => {
    const req = buildRequest(messages, true);
    const sid = `chat-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    activeStreamIdRef.current = sid;
    streamTextRef.current = "";

    streamUnlistenRef.current = (await listen<string>(`stream-chunk-${sid}`, (e) => {
      if (activeStreamIdRef.current !== sid) return;
      const delta = parseStreamDelta(e.payload, req.provider);
      if (delta) { streamTextRef.current += delta; setMsgs(p => p.map(m => m.id === msgId ? { ...m, body: streamTextRef.current } : m)); }
    })) as unknown as () => void;

    try {
      await invoke("curl_post_stream", { url: req.url, body: req.body, headers: req.headers, sessionId: sid });
    } finally {
      activeStreamIdRef.current = null;
      streamUnlistenRef.current?.();
      streamUnlistenRef.current = null;
      setMsgs(p => p.map(m => m.id === msgId ? { ...m, streaming: false, body: streamTextRef.current } : m));
    }
  };

  const handleStop = async () => {
    const sid = activeStreamIdRef.current;
    if (!sid) return;
    try { await invoke("cancel_stream", { sessionId: sid }); } catch {}
    activeStreamIdRef.current = null;
    streamUnlistenRef.current?.();
    streamUnlistenRef.current = null;
    setIsProcessing(false);
    setMsgs(p => p.map(m => m.streaming ? { ...m, streaming: false, body: streamTextRef.current } : m));
  };

  const callLLM = async (messages: { role: string; content: string }[]): Promise<string> => {
    const req = buildRequest(messages, false);
    const res = await invoke<string>("curl_post", { url: req.url, body: req.body, headers: req.headers });
    const d = JSON.parse(res);
    if (req.provider === "ollama") return d.message?.content || "_(no response)_";
    if (req.provider === "anthropic") return d.content?.[0]?.text || "_(no response)_";
    return d.choices?.[0]?.message?.content || "_(no response)_";
  };

  const autoDispatchActions = (actions: AgentAction[]) => {
    const usedSessionIds = new Set<string>();

    for (const action of actions) {
      if (action.type === "spawn" && action.agentType && action.prompt) {
        const promptText = action.prompt;
        // 1. Try to find a matching active session by label (case-insensitive) that isn't already targeted
        let existing = sessionsRef.current.find(s =>
          !usedSessionIds.has(s.sessionId) &&
          s.label.toLowerCase() === action.label.toLowerCase()
        );

        // 2. Fallback to finding by command/type
        if (!existing) {
          existing = sessionsRef.current.find(s =>
            !usedSessionIds.has(s.sessionId) &&
            s.command.toLowerCase() === action.agentType!.toLowerCase()
          );
        }

        if (existing) {
          // Reuse this active session!
          usedSessionIds.add(existing.sessionId);
          if (existing.status === "exited") {
            console.log(`[autoDispatchActions] Targeted spawn session ${existing.label} has exited. Restarting...`);
            const newSessId = onRestartSessionRef.current?.(existing.id);
            if (newSessId) {
              setTimeout(() => {
                console.log(`[autoDispatchActions] Sending prompt to restarted session: ${newSessId}`);
                onSendPtyCommandRef.current?.(newSessId, promptText);
              }, 4000);
            }
          } else if (existing.status === "booting") {
            console.log(`[autoDispatchActions] Targeted spawn session ${existing.label} is booting. Waiting...`);
            setTimeout(() => {
              console.log(`[autoDispatchActions] Sending prompt to booted session: ${existing.sessionId}`);
              onSendPtyCommandRef.current?.(existing.sessionId, promptText);
            }, 4000);
          } else {
            onSendPtyCommandRef.current?.(existing.sessionId, promptText);
          }
        } else {
          // Spawn a new session
          const s = onAddSessionRef.current?.(action.label, action.agentType);
          if (s) {
            usedSessionIds.add(s.sessionId);
            const sessId = s.sessionId;
            setTimeout(() => { onSendPtyCommandRef.current?.(sessId, promptText); }, 4000);
          }
        }
      } else if (action.type === "send" && action.prompt) {
        const promptText = action.prompt;
        // 1. Try to find a matching active session by exact label (case-insensitive) that isn't already used
        let t = sessionsRef.current.find(s =>
          !usedSessionIds.has(s.sessionId) &&
          s.label.toLowerCase() === action.label.toLowerCase()
        );

        // 2. Fallback to finding by sequential index (first unused session)
        if (!t) {
          t = sessionsRef.current.find(s => !usedSessionIds.has(s.sessionId));
        }

        if (t) {
          usedSessionIds.add(t.sessionId);
          if (t.status === "exited") {
            console.log(`[autoDispatchActions] Targeted send session ${t.label} has exited. Restarting...`);
            const newSessId = onRestartSessionRef.current?.(t.id);
            if (newSessId) {
              setTimeout(() => {
                console.log(`[autoDispatchActions] Sending prompt to restarted session: ${newSessId}`);
                onSendPtyCommandRef.current?.(newSessId, promptText);
              }, 4000);
            }
          } else if (t.status === "booting") {
            console.log(`[autoDispatchActions] Targeted send session ${t.label} is booting. Waiting...`);
            setTimeout(() => {
              console.log(`[autoDispatchActions] Sending prompt to booted session: ${t.sessionId}`);
              onSendPtyCommandRef.current?.(t.sessionId, promptText);
            }, 4000);
          } else {
            onSendPtyCommandRef.current?.(t.sessionId, promptText);
          }
        }
      } else if (action.type === "kill") {
        const t = sessionsRef.current.find(s => s.label.toLowerCase() === action.label.toLowerCase());
        if (t) onCloseSessionRef.current?.(t.id);
      }
    }
  };

  // ── Send ──────────────────────────────────────────────────────────────────────

  const send = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = input.trim();
    if (!text || isProcessing) return;
    setMsgs(p => [...p, { id: `u${Date.now()}`, role:"user", body: text, ts: ts() }]);
    setInput("");
    setIsProcessing(true);
    try {
      const sysPrompt = buildOrchestratorPrompt(sessionsRef.current, terminalOutputsRef.current);
      const history = msgs.filter(m => m.role === "user" || m.role === "ai").slice(-20).map(m => {
        let content = m.body;
        if (m.role === "ai" && m.actions?.length) {
          content += "\n\n" + m.actions.map(a =>
            a.type === "spawn" ? `[Spawned: ${a.label} via ${a.agentType}]`
            : a.type === "send" ? `[Sent to: ${a.label}]`
            : `[Killed: ${a.label}]`
          ).join(", ");
        }
        return { role: m.role === "user" ? "user" as const : "assistant" as const, content };
      });
      const llmMsgs = [{ role:"system", content: sysPrompt }, ...history, { role:"user", content: text }];
      const aiMsgId = `a${Date.now()}`;

      if (streamingEnabled) {
        setMsgs(p => [...p, { id: aiMsgId, role:"ai", agent:"orchestrator", body:"", streaming:true, ts: ts() }]);
        await streamLLM(aiMsgId, llmMsgs);
        const finalText = streamTextRef.current;
        const actions = parseAgentActions(finalText);
        const visible = stripAgentTags(finalText);
        setMsgs(p => p.map(m => m.id === aiMsgId ? { ...m, streaming:false, body: visible, actions: actions.length ? actions : undefined } : m));
        if (actions.length) autoDispatchActions(actions);
      } else {
        const resp = await callLLM(llmMsgs);
        const actions = parseAgentActions(resp);
        const visible = stripAgentTags(resp);
        setMsgs(p => [...p, { id: aiMsgId, role:"ai", agent:"orchestrator", body: visible, actions: actions.length ? actions : undefined, ts: ts() }]);
        if (actions.length) autoDispatchActions(actions);
      }
    } catch (err: any) {
      setMsgs(p => [...p, { id:`e${Date.now()}`, role:"ai", agent:"system", body:`**Error:** ${err.message||"Failed to get AI response."}`, ts: ts() }]);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className={`chat-panel ${embedded ? "embedded" : ""}`}>

      {/* ── Header ── */}
      <div className="chat-panel-header">
        <div className="chat-header-left">
          <span className={`chat-header-dot ${models.length > 0 ? "online" : "offline"}`} />
          <span className="chat-header-title">Integraded Chat</span>
        </div>

        <div className="chat-header-right">
          {/* Terminal spawner */}
          <div className="chat-header-dropdown-wrap" ref={termPickerRef}>
            <button
              type="button"
              className="chat-hdr-btn"
              title="New terminal"
              onClick={() => { setTermPickerOpen(o => !o); setHistoryOpen(false); }}
            >
              <i className="bx bx-plus-circle" />
            </button>
            {termPickerOpen && (
              <div className="chat-dropdown chat-term-picker">
                <div className="chat-dropdown-label">Launch terminal</div>
                {QUICK_AGENTS.map(ag => (
                  <button
                    key={ag.command}
                    type="button"
                    className="chat-dropdown-item"
                    onClick={() => {
                      onAddSessionRef.current?.(ag.label, ag.command);
                      setTermPickerOpen(false);
                    }}
                  >
                    <i className={`bx ${ag.icon}`} />
                    <span>{ag.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* History */}
          <div className="chat-header-dropdown-wrap" ref={historyRef}>
            <button
              type="button"
              className={`chat-hdr-btn ${historyOpen ? "active" : ""}`}
              title="Chat history"
              onClick={() => { setHistoryOpen(o => !o); setTermPickerOpen(false); }}
            >
              <i className="bx bx-history" />
              {histories.length > 0 && <span className="chat-hdr-badge">{histories.length}</span>}
            </button>
            {historyOpen && (
              <div className="chat-dropdown chat-history-panel">
                <div className="chat-history-header">
                  <span className="chat-dropdown-label">History</span>
                  <button type="button" className="chat-history-new-btn" onClick={saveAndNewChat}>
                    <i className="bx bx-plus" /> New chat
                  </button>
                </div>
                {histories.length === 0 ? (
                  <div className="chat-history-empty">No saved chats</div>
                ) : (
                  <div className="chat-history-list">
                    {histories.map(h => (
                      <div key={h.id} className="chat-history-item" onClick={() => loadHistory(h)}>
                        <div className="chat-history-item-name">{h.name}</div>
                        <div className="chat-history-item-meta">
                          <span>{relativeTime(h.createdAt)}</span>
                          <span className="chat-history-item-count">{h.msgs.length} msgs</span>
                        </div>
                        <button
                          type="button"
                          className="chat-history-del"
                          onClick={(e) => deleteHistory(h.id, e)}
                          title="Delete"
                        >
                          <i className="bx bx-trash" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Clear current */}
          <button
            type="button"
            className="chat-hdr-btn danger"
            title="Clear chat"
            onClick={saveAndNewChat}
          >
            <i className="bx bx-edit-alt" />
          </button>
        </div>
      </div>

      {/* ── Sessions strip (active terminals) ── */}
      {sessionsProp.length > 0 && (
        <div className="chat-sessions-strip">
          {sessionsProp.slice(0, 4).map(s => (
            <span key={s.sessionId} className="chat-sess-chip" title={`${s.command} — ${s.sessionId}`}>
              <i className="bx bx-terminal" />{s.label}
            </span>
          ))}
          {sessionsProp.length > 4 && (
            <span className="chat-sess-chip chat-sess-more">+{sessionsProp.length - 4}</span>
          )}
        </div>
      )}

      {/* ── Messages ── */}
      <div className="chat-messages">
        {msgs.length === 0 ? (
          <div className="chat-empty-state">
            <div className="chat-empty-icon"><i className="bx bx-network-chart" /></div>
            <span className="chat-empty-label">Integraded ready</span>
            <span className="chat-empty-sub">Describe what to build — agents spawn and work in parallel</span>
            <div className="chat-empty-tips">
              <span><i className="bx bx-plus-circle" /> Use + to add a terminal</span>
              <span><i className="bx bx-history" /> History shows past chats</span>
            </div>
          </div>
        ) : (
          msgs.map(m => {
            const isUser = m.role === "user";
            if (isUser) {
              return (
                <div key={m.id} className="chat-msg user">
                  <div className="chat-bubble-user">
                    <div className="chat-bubble-body">{formatBody(m.body)}</div>
                  </div>
                  <div className="chat-user-ts">{m.ts}</div>
                </div>
              );
            }
            return (
              <div key={m.id} className={`chat-msg ${m.agent || "ai"}`}>
                <div className="chat-msg-ai-wrap">
                  <span className={`chat-avatar ${m.agent || "ai"}`}>
                    <i className={`bx ${m.agent === "system" ? "bx-error-circle" : "bx-robot"}`} />
                  </span>
                  <div className="chat-msg-ai-content">
                    <div className="chat-msg-meta">
                      <span className="chat-sender">{m.agent === "system" ? "System" : "Integraded"}</span>
                      <span className="chat-ts">{m.ts}</span>
                    </div>
                    <div className={`chat-bubble-ai${m.agent === "system" ? " system-msg" : ""}`}>
                      <div className="chat-bubble-body">
                        {m.body ? formatBody(m.body) : null}
                        {m.streaming && <span className="chat-stream-cursor" />}
                      </div>
                      {m.actions && m.actions.length > 0 && !m.streaming && (
                        <div className="chat-dispatch">
                          <div className="chat-dispatch-title"><i className="bx bx-chip" /> Dispatched</div>
                          {m.actions.map((a, i) => (
                            <div key={i} className={`chat-dispatch-card dispatch-${a.type}`}>
                              <div className="chat-dispatch-header">
                                <span className={`chat-dispatch-type dispatch-type-${a.type}`}>{a.type}</span>
                                <span className="chat-dispatch-label">{a.label}</span>
                                {a.agentType && <span className="chat-dispatch-agent">{a.agentType}</span>}
                                <i className="bx bx-check-circle chat-dispatch-ok" />
                              </div>
                              {a.prompt && <div className="chat-dispatch-prompt">{a.prompt.length > 130 ? a.prompt.slice(0,130)+"…" : a.prompt}</div>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}

        {isProcessing && !msgs.some(m => m.streaming) && (
          <div className="chat-msg orchestrator">
            <div className="chat-msg-ai-wrap">
              <span className="chat-avatar orchestrator"><i className="bx bx-robot" /></span>
              <div className="chat-msg-ai-content">
                <div className="chat-msg-meta">
                  <span className="chat-sender">Integraded</span>
                </div>
                <div className="chat-bubble-ai">
                  <div className="chat-typing"><span/><span/><span/></div>
                </div>
              </div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* ── Composer ── */}
      <form className="chat-composer" onSubmit={send}>
        <div className="chat-composer-inner">
          <div className="chat-input-box">
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isRecording ? "Listening…" : "Describe the task…"}
              rows={1}
              disabled={isRecording || isProcessing}
            />
            <div className="chat-input-footer">
              {/* Model picker */}
              <div className="chat-model-pill" ref={modelDropdownRef}>
                <button
                  ref={pillBtnRef}
                  type="button"
                  className="chat-pill-btn"
                  onClick={() => {
                    setModelDropdownOpen(o => {
                      if (!o) {
                        setModelSearch("");
                        // Compute position: anchor dropdown above the button
                        const rect = pillBtnRef.current?.getBoundingClientRect();
                        if (rect) {
                          // Place dropdown above the button, left-aligned
                          setDropdownPos({
                            top: rect.top - 8,   // will be shifted up by transform
                            left: Math.max(8, rect.left),
                          });
                        }
                      }
                      return !o;
                    });
                  }}
                >
                  <i className="bx bx-chip" />
                  <span className="chat-model-name">{selectedModel ? selectedModel.split('/').pop() : 'model'}</span>
                  <i className={`bx bx-chevron-up ${modelDropdownOpen ? 'open' : ''}`} />
                </button>
                {modelDropdownOpen && dropdownPos && (
                  <div
                    className="chat-pill-dropdown chat-pill-dropdown-wide"
                    data-model-dropdown="true"
                    style={{
                      top: dropdownPos ? dropdownPos.top : 0,
                      left: dropdownPos ? dropdownPos.left : 0,
                      transform: 'translateY(-100%)',
                    }}
                  >
                    <div className="chat-pill-search">
                      <i className="bx bx-search" />
                      <input type="text" placeholder="Search models…" value={modelSearch} onChange={e => setModelSearch(e.target.value)} autoFocus onKeyDown={e => e.stopPropagation()} />
                    </div>
                    <div className="chat-pill-scroll">
                      {(() => {
                        const filt = models.filter(m => !modelSearch || m.value.toLowerCase().includes(modelSearch.toLowerCase()) || (m.label||"").toLowerCase().includes(modelSearch.toLowerCase()) || m.providerName.toLowerCase().includes(modelSearch.toLowerCase()));
                        const grouped: {provider:string;providerName:string;items:ModelEntry[]}[] = [];
                        const seen = new Set<string>();
                        for (const m of filt) {
                          if (!seen.has(m.provider)) { seen.add(m.provider); grouped.push({ provider: m.provider, providerName: m.providerName, items: filt.filter(x => x.provider === m.provider) }); }
                        }
                        if (!grouped.length) return <div className="chat-pill-empty">No models found</div>;
                        return grouped.map(g => (
                          <div key={g.provider} className="chat-pill-group">
                            <div className="chat-pill-group-label">{g.providerName}</div>
                            {g.items.map(m => (
                              <button key={m.value} type="button" className={`chat-pill-item ${m.value === selectedModel ? 'active' : ''}`} onClick={() => { setSelectedModel(m.value); setSelectedCloudProvider(m.provider); setModelDropdownOpen(false); }}>
                                <span className="chat-pill-item-text">{m.label || m.value.split('/').pop()}</span>
                                {m.value === selectedModel && <i className="bx bx-check" />}
                              </button>
                            ))}
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                className={`chat-mic-btn ${isRecording ? "recording" : ""}`}
                onClick={toggleRecording}
                title={isRecording ? "Stop" : "Voice input"}
              >
                <i className={`bx bx-microphone${isRecording ? "-off" : ""}`} />
              </button>
            </div>
          </div>

          {isProcessing ? (
            <button type="button" className="chat-send-btn stop" onClick={handleStop} title="Stop">
              <i className="bx bx-stop" />
            </button>
          ) : (
            <button type="submit" className="chat-send-btn" disabled={!input.trim()}>
              <i className="bx bx-send" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
};
