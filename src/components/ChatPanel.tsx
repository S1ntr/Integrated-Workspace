import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useNotify } from "./Notification";
import type { BrowserOpenRequest, ChatAttachment, ExternalChatPrompt } from "../types/browser";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Session {
  id: number;
  sessionId: string;
  label: string;
  command: string;
  status?: "booting" | "running" | "exited";
}

interface AgentAction {
  type: "spawn" | "send" | "broadcast" | "kill" | "request" | "ask_user" | "browser_open" | "mode" | "file_create" | "read_file" | "exec_cmd";
  agentType?: string;
  label: string;
  prompt?: string;
  count?: number;
  reason?: string;
  question?: string;
  url?: string;
  device?: string;
  mode?: string;
  filePath?: string;
  cmdString?: string;
  result?: string;
}

interface ToolCallLog {
  id: string;
  action: AgentAction;
  status: "queued" | "running" | "waiting" | "done" | "failed";
  ts: string;
  note?: string;
}

export interface ChatDiffFile {
  name: string;
  path: string;
  status: "new" | "modified";
}

interface DiffLog {
  id: string;
  files: ChatDiffFile[];
  total: number;
  ts: string;
}

interface AgentQuestion {
  id: string;
  sessionId: string;
  label: string;
  question: string;
  ts: string;
  answered?: boolean;
}

interface PendingAgentRequest {
  id: string;
  label: string;
  agentType: string;
  count: number;
  prompt?: string;
  reason?: string;
  existingSessionIds: string[];
  fulfilledSessionIds: string[];
}

interface PendingPlan {
  planText: string;
  requestedAt: number;
  fileName: string;
}

export interface MentionFile {
  path: string;
  name: string;
}

export interface TerminalTranscriptEntry {
  id: string;
  sessionId: string;
  label: string;
  kind: "output" | "input" | "system";
  text: string;
  ts: number;
}

interface SkillLog {
  /** Skills that were matched and injected. */
  skills: Array<{ name: string; slug: string }>;
  /** Label of the terminal agent that received the injection, or "chat" for detection-only log. */
  agentLabel: string;
  /** detected = found in user msg; injected = sent inline in prompt; file_written = also written to workspace. */
  status: "detected" | "injected" | "file_written" | "failed";
  /** Workspace paths of files that were written (one per skill). */
  filePaths?: string[];
}

interface Msg {
  id: string;
  role: "ai" | "user";
  body: string;
  ts: string;
  streaming?: boolean;
  agent?: "orchestrator" | "system" | "tool" | "diff" | "skill";
  actions?: AgentAction[];
  attachments?: ChatAttachment[];
  toolLog?: ToolCallLog;
  diffLog?: DiffLog;
  skillLog?: SkillLog;
  thinking?: {
    text: string;
    elapsedMs: number;
    open: boolean;
    done?: boolean;
  };
}

interface ChatHistory {
  id: string;
  name: string;
  msgs: Msg[];
  contextWindow?: string;
  createdAt: number;
  folderName?: string;
}

interface ChatSessionMeta {
  id: string;
  createdAt: number;
  folderName: string;
}

interface WorkMonitor {
  id: string;
  startedAt: number;
  actions: number;
  sessionIds: string[];
}

interface ModelEntry {
  value: string;
  label?: string;
  provider: string;
  providerName: string;
  type: "cloud" | "local";
}

interface InstalledSkill {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  description: string;
  triggers: string[];
  skill_md: string;
  installed_at: number;
}

// ─── Skill helpers ────────────────────────────────────────────────────────────

/** Return skills whose triggers/name match the user message. */
function matchSkills(message: string, skills: InstalledSkill[]): InstalledSkill[] {
  if (!skills.length || !message.trim()) return [];
  const msg = message.toLowerCase();
  return skills.filter(skill => {
    if (skill.triggers.some(t => t.length >= 3 && msg.includes(t.toLowerCase()))) return true;
    const nameWords = skill.name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (nameWords.some(w => msg.includes(w))) return true;
    return false;
  });
}

/** Build a skill block to prepend to system/user prompts. */
function buildSkillBlock(skills: InstalledSkill[]): string {
  if (!skills.length) return "";
  return skills.map(s =>
    `\n\n---\n[SKILL: ${s.name}]\n${s.skill_md}\n---`
  ).join("");
}

/** Notification line to tell the agent which skills are attached. */
function skillNotice(skills: InstalledSkill[]): string {
  if (!skills.length) return "";
  const names = skills.map(s => `"${s.name}"`).join(", ");
  return `\n\n[Integraded: The following skills are attached and should be applied: ${names}]`;
}

/** Build file-reference lines pointing to workspace .integraded-skills/ files. */
function buildSkillFileRef(skills: InstalledSkill[], filePaths: string[]): string {
  if (!filePaths.length) return "";
  const lines = skills
    .map((s, i) => filePaths[i] ? `  - ${s.name}: .integraded-skills/${s.slug}.md` : "")
    .filter(Boolean);
  if (!lines.length) return "";
  return `\n\n[SKILL FILES written to workspace — read these before starting:\n${lines.join("\n")}\nThese files contain detailed instructions for each skill. Follow them exactly.]`;
}

/** Render a SkillLog entry (similar to renderToolLog). Pure function, no hooks. */
export function renderSkillLog(log: SkillLog): React.ReactNode {
  const statusIcon = log.status === "detected" ? "bx-search"
    : log.status === "file_written" ? "bx-file"
    : log.status === "failed" ? "bx-error-circle"
    : "bx-extension";
  const statusLabel = log.status === "detected" ? "detected"
    : log.status === "file_written" ? "files written"
    : log.status === "failed" ? "failed"
    : "injected";
  const note = log.filePaths?.length
    ? log.filePaths.map(p => p.replace(/\\/g, "/").split("/").slice(-2).join("/")).join(", ")
    : "";
  return (
    <div className={`chat-skill-log status-${log.status}`}>
      <div className="chat-skill-log-row">
        <i className={`bx ${statusIcon} chat-skill-icon`} />
        <span className="chat-skill-status">{statusLabel}</span>
        <span className="chat-skill-chips">
          {log.skills.map(s => (
            <span key={s.slug} className="chat-skill-chip">
              <i className="bx bx-extension" />
              {s.name}
            </span>
          ))}
        </span>
        {log.agentLabel && log.agentLabel !== "chat" && (
          <>
            <span className="chat-tool-arrow">{"→"}</span>
            <span className="chat-skill-target">{log.agentLabel}</span>
          </>
        )}
      </div>
      {note && <div className="chat-skill-log-note">{note}</div>}
    </div>
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────

const QUICK_AGENTS = [
  { label: "Shell",       command: "shell",       icon: "bx-terminal" },
  { label: "Claude",      command: "claude",       icon: "bx-bot" },
  { label: "opencode",    command: "opencode",     icon: "bx-code-alt" },
  { label: "Codex",       command: "codex",        icon: "bx-terminal" },
  { label: "Antigravity", command: "antigravity",  icon: "bx-rocket" },
];

// Cloud models are fetched live from each provider's API — no hardcoded list.

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic", deepseek: "DeepSeek",
  mistral: "Mistral", google: "Google", grok: "Grok",
  together: "Together AI", openrouter: "OpenRouter", ollama_cloud: "Ollama Cloud",
  nvidia: "NVIDIA NIM",
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
  const lines = stripAgentTags(body).split("\n");
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

/**
 * Returns true if the model's text describes intending to spawn/send/use agents
 * but produced zero tool_call blocks — used to warn the user when a model ignores
 * the required tool call format.
 */
function detectsAgentIntent(text: string): boolean {
  if (!text.trim()) return false;
  // Already has tool calls → no warning needed
  if (/<tool_call>/i.test(text) || /```tool_call/i.test(text)) return false;
  const lower = text.toLowerCase();
  return (
    /\bspawn\b|\bspawnu\b|\bspawním\b/.test(lower) ||
    /\buse (an? |one |the )?agent\b/.test(lower) ||
    /\bcreate (an? |one |the )?agent\b/.test(lower) ||
    /\bopen(code|code agent)\b/.test(lower) ||
    /\b(pošlu|spustím|použiji|vytvořím|zavolám).{0,30}agent/.test(lower) ||
    /agent.{0,30}(spustím|pošlu|použiji|vytvořím|zavolám)/.test(lower) ||
    /\bI('ll| will) (spawn|use|create|start|launch|dispatch).{0,30}agent/.test(lower) ||
    /\bI('ll| will) (use|task|assign).{0,30}(opencode|claude|codex)/.test(lower)
  );
}

/** Extract a human-readable error string from any provider error JSON, or null. */
function parseStreamError(d: any): string | null {
  if (!d || typeof d !== "object") return null;
  const e = d.error;
  if (!e) return null;
  if (typeof e === "string") return e;
  if (typeof e === "object") return e.message || e.msg || JSON.stringify(e);
  return null;
}

function parseStreamDelta(line: string, provider: string): string | null {
  if (!line.trim()) return null;
  // Strip SSE "data: " prefix universally — all providers may send SSE lines
  const jsonStr = line.startsWith("data: ") ? line.slice(6).trim() : line.trim();
  if (!jsonStr || jsonStr === "[DONE]") return null;

  try {
    const d = JSON.parse(jsonStr);
    // Surface API-level errors as visible content so they're never silently swallowed
    const err = parseStreamError(d);
    if (err) return `\n⚠️ **API error:** ${err}\n`;

    if (provider === "ollama" || provider === "ollama_cloud") {
      // Ollama NDJSON: {"response":"..."} or {"message":{"content":"..."}}
      // Ollama Cloud may also use OpenAI-compat SSE: {"choices":[{"delta":{"content":"..."}}]}
      return d.response || d.message?.content || d.choices?.[0]?.delta?.content || null;
    }
    if (provider === "anthropic") {
      // Anthropic SSE data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
      if (d.type === "content_block_delta" && d.delta?.type === "text_delta") return d.delta.text || null;
      return null;
    }
    // OpenAI-compatible SSE: {"choices":[{"delta":{"content":"..."}}]}
    return d.choices?.[0]?.delta?.content || null;
  } catch { return null; }
}

function parseStreamThinking(line: string, provider: string): string | null {
  if (!line.trim()) return null;
  const jsonStr = line.startsWith("data: ") ? line.slice(6).trim() : line.trim();
  if (!jsonStr || jsonStr === "[DONE]") return null;
  try {
    const d = JSON.parse(jsonStr);
    if (provider === "ollama" || provider === "ollama_cloud") {
      return d.message?.thinking || d.message?.reasoning || d.thinking || d.reasoning || null;
    }
    if (provider === "anthropic") {
      // Anthropic extended thinking: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"..."}}
      if (d.type === "content_block_delta" && d.delta?.type === "thinking_delta") return d.delta.thinking || null;
      return null;
    }
    // OpenAI-compat (DeepSeek, OpenRouter reasoning, etc.)
    const delta = d.choices?.[0]?.delta || {};
    return delta.reasoning_content || delta.reasoning || delta.thinking || null;
  } catch {
    return null;
  }
}

// ─── Agent action parser ──────────────────────────────────────────────────────

function safeJsonParse(raw: string): any | null {
  try { return JSON.parse(raw.trim()); } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

function parseMaybeArguments(value: any): any {
  if (!value) return {};
  if (typeof value === "string") return safeJsonParse(value) || { prompt: value };
  if (typeof value === "object") return value;
  return {};
}

function expandToolLike(raw: any): any[] {
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw)) return raw.flatMap(expandToolLike);
  if (Array.isArray(raw.tool_calls)) return raw.tool_calls.flatMap(expandToolLike);
  if (Array.isArray(raw.tools)) return raw.tools.flatMap(expandToolLike);
  if (raw.function && typeof raw.function === "object") {
    return [{ ...parseMaybeArguments(raw.function.arguments), tool: raw.function.name || raw.name || raw.tool || raw.type }];
  }
  if (raw.name && raw.arguments !== undefined) return [{ ...parseMaybeArguments(raw.arguments), tool: raw.name }];
  if (raw.tool_name && raw.args !== undefined) return [{ ...parseMaybeArguments(raw.args), tool: raw.tool_name }];
  return [raw];
}

function normalizeToolAction(raw: any): AgentAction | null {
  if (!raw || typeof raw !== "object") return null;
  const rawTool = String(raw.tool || raw.type || raw.name || raw.action || "").trim().toLowerCase();
  const tool = rawTool.replace(/^(agent|chat|browser)[._:-]/, "");
  const label = String(raw.label || raw.session || raw.target || raw.agent || raw.to || "").trim();
  const prompt = typeof raw.prompt === "string" ? raw.prompt
    : typeof raw.message === "string" ? raw.message
    : typeof raw.input === "string" ? raw.input
    : typeof raw.text === "string" ? raw.text
    : undefined;
  const agentType = typeof raw.agentType === "string" ? raw.agentType : typeof raw.agent_type === "string" ? raw.agent_type : typeof raw.command === "string" ? raw.command : undefined;
  const count = Number.isFinite(Number(raw.count)) ? Math.max(1, Math.min(16, Number(raw.count))) : undefined;
  const reason = typeof raw.reason === "string" ? raw.reason : undefined;
  const question = typeof raw.question === "string" ? raw.question : typeof raw.body === "string" ? raw.body : undefined;
  const url = typeof raw.url === "string" ? raw.url : typeof raw.href === "string" ? raw.href : undefined;
  const device = typeof raw.device === "string" ? raw.device : typeof raw.viewport === "string" ? raw.viewport : undefined;
  const requestedMode = typeof raw.mode === "string" ? raw.mode : typeof raw.agent_mode === "string" ? raw.agent_mode : undefined;
  const allTargets = /^(all|\*|everyone|agents)$/i.test(label) || raw.all === true || raw.broadcast === true;

  if (tool === "spawn" || tool === "create" || tool === "start") return { type: "spawn", label: label || agentType || "Agent", agentType, prompt };
  if (tool === "broadcast" || (tool === "send" && allTargets)) return { type: "broadcast", label: label || "all agents", prompt };
  if (tool === "send" || tool === "prompt" || tool === "message") return { type: "send", label: label || "Agent", prompt };
  if (tool === "kill" || tool === "close") return { type: "kill", label: label || "Agent" };
  if (tool === "mode" || tool === "switch" || tool === "change_mode") return { type: "mode", label: label || "Agent", agentType, mode: requestedMode || agentType, prompt, reason };
  if (tool === "request" || tool === "need" || tool === "ask_agent") return { type: "request", label: label || agentType || "Agent", agentType, count: count || 1, prompt, reason };
  if ((rawTool.startsWith("browser.") || url) && (tool === "open" || tool === "navigate")) {
    return { type: "browser_open", label: label || "Browser", url, device, prompt, reason, mode: requestedMode };
  }
  if (tool === "ask_user" || tool === "ask" || tool === "question") {
    return { type: "ask_user", label: label || "User", question: question || prompt || reason || "Need more information.", reason };
  }
  // File read tool
  const filePath = typeof raw.path === "string" ? raw.path : typeof raw.file === "string" ? raw.file : typeof raw.filePath === "string" ? raw.filePath : prompt;
  if (tool === "read_file" || tool === "read" || tool === "cat" || tool === "view_file") {
    return { type: "read_file", label: filePath || "file", filePath };
  }
  // Command execution tool
  const cmdString = typeof raw.cmd === "string" ? raw.cmd : typeof raw.command === "string" ? raw.command : typeof raw.run === "string" ? raw.run : prompt;
  if (tool === "exec_cmd" || tool === "exec" || tool === "run" || tool === "bash" || tool === "shell_cmd") {
    return { type: "exec_cmd", label: cmdString || "command", cmdString };
  }
  return null;
}

function parseAgentActions(text: string): AgentAction[] {
  const actions: AgentAction[] = [];
  const seen = new Set<string>();
  const pushAction = (action: AgentAction | null) => {
    if (!action) return;
    const key = JSON.stringify(action);
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(action);
  };

  const parseJsonBlock = (raw: string) => {
    const parsed = safeJsonParse(raw);
    if (!parsed) return;
    for (const item of expandToolLike(parsed)) pushAction(normalizeToolAction(item));
  };

  for (const match of text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)) parseJsonBlock(match[1]);
  for (const match of text.matchAll(/```(?:tool_call|tool|tools|json)?\s*([\s\S]*?)```/gi)) parseJsonBlock(match[1]);
  for (const match of text.matchAll(/\b(?:tool_call|tool)\s*:\s*(\{[^\n]+?\})(?=\s*$)/gim)) parseJsonBlock(match[1]);

  for (const line of text.split("\n")) {
    const t = line.trim();
    const spawn = t.match(/^\[AGENT:spawn:([^:]+):([^\]]+)\]\s*([\s\S]*)/);
    if (spawn) { pushAction({ type:"spawn", agentType: spawn[1].trim().toLowerCase(), label: spawn[2].trim(), prompt: spawn[3].trim() }); continue; }
    const send = t.match(/^\[AGENT:send:([^\]]+)\]\s*([\s\S]*)/);
    if (send) { pushAction({ type:"send", label: send[1].trim(), prompt: send[2].trim() }); continue; }
    const kill = t.match(/^\[AGENT:kill:([^\]]+)\]/);
    if (kill) pushAction({ type:"kill", label: kill[1].trim() });
    const toolLine = t.match(/^\[TOOL_CALL\]\s*(\{.*\})$/);
    if (toolLine) parseJsonBlock(toolLine[1]);
    const fnCall = t.match(/^(agent|chat|browser)[._](spawn|send|broadcast|request|kill|mode|change_mode|open|navigate|ask_user|ask)\(([\s\S]*)\)\s*$/i);
    if (fnCall) {
      const namespace = fnCall[1].toLowerCase();
      const method = fnCall[2].toLowerCase();
      const argsRaw = fnCall[3].trim();
      const normalizedArgs = argsRaw.startsWith("{") ? argsRaw : `{${argsRaw.replace(/(\w+)\s*=/g, '"$1":')}}`;
      pushAction(normalizeToolAction({ ...(safeJsonParse(normalizedArgs) || {}), tool: `${namespace}.${method}` }));
    }
  }
  return actions;
}

function stripAgentTags(text: string): string {
  return text
    .replace(/```tool_call\s*[\s\S]*?```/gi, "")
    .replace(/```(?:tool|tools|json)\s*[\s\S]*?```/gi, block => parseAgentActions(block).length ? "" : block)
    .replace(/```tool_call[\s\S]*$/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_call>[\s\S]*$/gi, "")
    .split("\n")
    .filter(l => !/^\[(AGENT|TOOL_CALL)(:|\])/.test(l.trim()))
    .filter(l => !/^(agent|chat|browser)[._](spawn|send|broadcast|request|kill|mode|change_mode|open|navigate|ask_user|ask)\(/i.test(l.trim()))
    .join("\n")
    .trim();
}

function visibleStreamText(text: string): string {
  return stripAgentTags(text).replace(/\n{3,}/g, "\n\n");
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "");
}

function detectTerminalQuestion(text: string): string | null {
  const cleaned = stripAnsi(text).trim();
  if (!cleaned) return null;
  const tail = cleaned.split("\n").map(l => l.trim()).filter(Boolean).slice(-6).reverse();
  const progressNoise = /\b(let me|i will|i'll|checking|reading|updating|running|writing|building|installing)\b/i;
  for (const line of tail) {
    if (line.length < 3 || line.length > 220 || progressNoise.test(line)) continue;
    if (/\[(y\/n|Y\/n|y\/N|yes\/no|Yes\/No)\]\s*$/i.test(line)) return line;
    if (/\b(continue|proceed|confirm|approve|overwrite|permission)\b.*[?:]\s*$/i.test(line)) return line;
    if (/\b(select|choose)\b.*:\s*$/i.test(line)) return line;
    if (/\?$/.test(line) && /\b(should|do|does|is|are|can|could|would|will|may|which|what|where|when|how)\b/i.test(line)) {
      return line;
    }
  }
  return null;
}

export function detectAgentCompletionSummary(text: string): string | null {
  const cleaned = stripAnsi(text).trim();
  if (!cleaned) return null;
  const lines = cleaned.split("\n").map(l => l.trim()).filter(Boolean).slice(-18);
  
  // Filter out TUI status bars, hotkey reminders, progress indicators, or raw terminal block elements
  const textLines = lines.filter(line => {
    if (/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)) return false;
    if (looksLikeTerminalNoise(line)) return false;
    if (/\b(ctrl\+p|ctrl\+c|commands|hotkeys)\b/i.test(line)) return false;
    return true;
  });

  const joined = textLines.join("\n");
  if (detectTerminalQuestion(joined)) return null;
  
  if (!/\b(summary|changes made|task complete|completed|finished|all set|done|implemented|fixed)\b/i.test(joined)) {
    return null;
  }
  if (/\b(let me|i will|i'll|going to|updating todos|checking|reading)\b/i.test(textLines.slice(-4).join(" "))) {
    return null;
  }
  
  const summaryLines = textLines
    .filter(line => !/^thought:?/i.test(line))
    .slice(-8);
  const summary = summaryLines.join("\n").slice(0, 900);
  if (!summary || looksLikeTerminalNoise(summary)) return null;
  return summary;
}

// ─── Orchestrator system prompt ───────────────────────────────────────────────

function buildOrchestratorPrompt(
  sessions: Session[],
  outputs: Record<string, string>,
  transcripts: Record<string, TerminalTranscriptEntry[]> = {},
  toolCalls: ToolCallLog[] = [],
  pendingQuestions: AgentQuestion[] = [],
  contextWindow = "",
  installedSkills: InstalledSkill[] = [],
): string {
  const MAX_TERMINALS = 16;
  const availableSlots = Math.max(0, MAX_TERMINALS - sessions.length);

  const sessionList = sessions.length > 0
    ? sessions.map(s => `- ${s.label} (${s.command}, ${s.status || "unknown"})`).join("\n")
    : "(none — use spawn actions to create terminals)";

  const now = Date.now();
  const outputBlocks = sessions
    .filter(s => outputs[s.sessionId]?.trim() || transcripts[s.sessionId]?.length)
    .map(s => {
      const sessionTranscripts = transcripts[s.sessionId] || [];
      // Compute freshness from last transcript entry timestamp
      const lastTs = sessionTranscripts.length
        ? Math.max(...sessionTranscripts.map(e => e.ts))
        : 0;
      const ageSec = lastTs ? Math.round((now - lastTs) / 1000) : null;
      const freshness = ageSec !== null
        ? ageSec < 5 ? " — active now" : ` — last activity ${ageSec}s ago`
        : "";

      const structured = sessionTranscripts.slice(-20).map(entry => {
        const prefix = entry.kind === "input" ? "→ sent" : entry.kind === "system" ? "[system]" : "output";
        return `${prefix}: ${entry.text.replace(/\s+/g, " ").slice(-700)}`;
      }).join("\n");
      const fallback = (outputs[s.sessionId] || "").slice(-1400).trim();
      return `### ${s.label} (${s.command}, ${s.status || "unknown"}${freshness})\n\`\`\`\n${structured || fallback}\n\`\`\``;
    })
    .join("\n\n");

  const recentTools = toolCalls.slice(-12).map(t =>
    `- ${t.ts} ${t.action.type.toUpperCase()} ${t.action.label} [${t.status}]${t.note ? `: ${t.note}` : ""}`
  ).join("\n");

  const questionBlocks = pendingQuestions.filter(q => !q.answered).slice(-5).map(q =>
    `- ${q.label}: ${q.question}`
  ).join("\n");

  const skillsList = installedSkills.length > 0
    ? installedSkills.map(s => `- **${s.name}** (\`${s.slug}\`): ${s.description}\n  Triggers: ${s.triggers.join(", ")}`).join("\n")
    : "(none installed — tell the user they can browse/install skills from the Skills tab)";

  return `You are the **Orchestrator** in "Integraded" — an integrated multi-agent development workspace.

## Role
Break user requests into parallel sub-tasks. Dispatch each to dedicated CLI coding agents in real terminals, monitor their transcript, answer their follow-up questions when the user's intent is clear, and ask the user when it is not.

## Active Sessions (${sessions.length} running, ${availableSlots} slots free, max 16)
${sessionList}

## Available Agent Types
- \`claude\` — Anthropic Claude CLI (complex coding, architecture)
- \`opencode\` — opencode.ai (fast, focused file tasks)
- \`codex\` — OpenAI Codex CLI
- \`shell\` — PowerShell/bash (commands, installs, scripts)
- \`antigravity\` — Antigravity CLI

## ⚡ MANDATORY: Tool Calls — you MUST output these, always
Tool calls are **not optional**. Every time you decide to spawn, send, or manage an agent you MUST output the tool call XML — outputting only prose that describes what you intend to do is NOT enough and the action will never execute.

Rule: **think in prose, act in tool calls**. Write one short visible sentence explaining what you are doing, then IMMEDIATELY follow it with the tool call(s). Do NOT describe the action and stop there.

✅ CORRECT (prose + tool call together):
I'll spawn one opencode agent to build the snake game.
<tool_call>{"tool":"agent.spawn","agentType":"opencode","label":"Snake Game","prompt":"Create a modern snake game in index.html using HTML, CSS and JS. Single file, full game with score, speed increase and game-over screen."}</tool_call>

❌ WRONG (describing action without tool call — never do this):
I'll use one of the existing opencode agents to handle this task.

Available tool calls:
<tool_call>{"tool":"agent.send","label":"Existing Agent Label","prompt":"Message to send to the CLI agent"}</tool_call>
<tool_call>{"tool":"agent.spawn","agentType":"opencode","label":"Frontend Agent","prompt":"Focused task for this new agent"}</tool_call>
<tool_call>{"tool":"agent.broadcast","label":"all","prompt":"Shared coordination update for every useful open agent"}</tool_call>
<tool_call>{"tool":"agent.request","agentType":"claude","label":"Review Agent","count":1,"reason":"Need another reviewer","prompt":"Task to send once the user adds that agent"}</tool_call>
<tool_call>{"tool":"agent.mode","label":"Existing Agent Label","agentType":"codex","reason":"Switch this terminal to Codex CLI"}</tool_call>
<tool_call>{"tool":"agent.kill","label":"Agent Label"}</tool_call>
<tool_call>{"tool":"browser.open","url":"http://localhost:3000","device":"responsive","mode":"app","label":"Project Preview"}</tool_call>
<tool_call>{"tool":"chat.ask_user","question":"Precise question for the user"}</tool_call>
<tool_call>{"tool":"read_file","path":"src/App.tsx"}</tool_call>
<tool_call>{"tool":"exec_cmd","command":"npm test"}</tool_call>

If XML is not supported by your model, a fenced code block is also accepted:
\`\`\`tool_call
{"tool":"agent.spawn","agentType":"opencode","label":"Agent Name","prompt":"Task"}
\`\`\`
Tool call XML/blocks are hidden from the user — they see only your visible prose summary and an inline action log.

## read_file / exec_cmd (direct tools — no agent needed)
Use \`read_file\` to inspect any workspace file yourself before deciding on a plan. Use \`exec_cmd\` to run a quick command (test, lint, build check) and see the output in chat. These run instantly without spawning a terminal agent.

## Task Complexity → Agent Count (REQUIRED DECISION BEFORE ACTING)
Classify the request first, then pick the right agent count:

| Complexity | Signals | Agents to use |
|------------|---------|---------------|
| **Trivial** | Single question, doc lookup, ≤1 file change, simple script | **1 agent** — send to an existing session |
| **Small** | Bug fix, 1-3 file edits, single feature area | **1 agent** — spawn one if none free |
| **Medium** | 3-8 files, 2+ independent concerns (e.g. backend + frontend) | **2-3 agents** — split by concern |
| **Large** | Full feature, new module, 8+ files, multiple layers (API/UI/tests/config) | **4-${Math.min(availableSlots + sessions.length, 8)} agents** — saturate available slots |
| **Huge** | Full-stack feature, architectural refactor, new app scaffold | **Use all ${availableSlots} free slots** — maximize parallelism |

**Coupling test (run this BEFORE choosing agent count):** Ask "could two different people write these pieces simultaneously without reading each other's output?" If NO → it is tightly coupled → use 1 agent.

**TIGHTLY COUPLED = 1 agent only (no matter how many files):**
- HTML + CSS + JS for the same page/component
- React component + its .css/.scss file
- A function + its unit tests
- A config file + the code that reads it
- Backend route + its frontend API call
- Any feature where File A imports or depends on File B being done first

**TRULY PARALLEL = can split agents:**
- Separate pages (e.g. homepage vs. about page — different files, no shared logic)
- Independent API endpoints with no shared state
- Distinct features in completely separate modules
- Backend + Frontend only when the API contract is already defined/stable

**Decision rule:** If you're unsure → 1 agent. Adding agents later is cheap; untangling conflicting edits is expensive.
When in doubt, go ONE step LOWER on agent count.

## Coordination Rules
1. **AVOID UNNECESSARY SPAWNS**: Do not *spawn new* sessions for simple, minor, or single-file tasks. However, if the user already has multiple active sessions open in the workspace, prefer to distribute and parallelize sub-tasks among all of them (e.g. dividing file research, test runs, and edits) to maximize speed, rather than letting active agents sit idle or closing them. Never kill or close active terminal sessions unless the user explicitly requests it.
2. **SCALE UP FOR COMPLEX WORK**: For large projects with many independent concerns, spawn agents to fill the available terminal slots (up to the limit shown above). Parallel work on independent modules/layers saves significant time. Do NOT bottleneck a large project through a single terminal.
3. **REUSE ACTIVE SESSIONS**: ALWAYS prefer sending tasks to already active sessions. If a running active session listed under "Active Sessions" above can handle the task, use \`agent.send\` to send the prompt to it. Do not spawn a new session if a matching/compatible session already exists.
4. Unique descriptive labels: "HTML Builder", "CSS Stylist", "JS Developer", etc.
5. Each agent gets ONE focused task with FULL context: file names, shared types, conventions
6. Never assign two agents to the same file
7. If agent A defines a shared type, paste the full definition into agent B's prompt
8. If more agents are needed but you should not create them yourself, use \`agent.request\`; the app will detect newly added matching agents and dispatch your queued prompt.
9. If a CLI agent asks a question and the answer follows from the user's instruction, answer it with \`agent.send\`. If uncertain, use \`chat.ask_user\`.
10. If the user asks to open, inspect, test, or preview a web/app UI, use \`browser.open\` with the best local URL from terminal output. If no URL is known, ask the user for it.
11. Browser feedback may include a URL, viewport, selected element/region, and user note. Use that context to prompt agents with precise visual/UI fixes.
12. When an agent finishes, convert its terminal output into a concise visible summary of changed files, integrations, tests, and remaining risks. Do not show a question card unless the terminal is clearly waiting for user input.
13. After dispatching, briefly summarize what each agent is doing (visible to user)
14. The user may mention files with @filename, @path/file, or quoted @"path with spaces". Pass exact resolved paths to agents and tell them to inspect those files before editing. If a mention is unresolved, tell the agent to locate it with workspace search before touching files.
15. When all dispatched agents are quiet and no unanswered questions remain, provide one concise final project-ready summary with changed files, verification, risks, and run/preview hints. Avoid repeating noisy terminal UI output.
16. **UNIQUE SUB-TASKS ONLY**: Each agent MUST receive a completely unique, specialized sub-task prompt. You MUST NOT send the exact same prompt or instructions to multiple agents. Work MUST be partitioned and divided logically between them. If you partition work across multiple parallel agents, you (the Orchestrator) must manage the aggregation: wait for all worker agents to finish, collect their outputs from the console logs, and pass that information to a synthesis/report agent. Do not instruct an agent to look at or wait for another terminal.
17. **COORDINATED DISPATCH (WAIT FOR ALL AGENTS)**: You MUST wait for ALL active agents in the context to complete their tasks (i.e. all monitored sessions must finish running, showing summaries/questions, or exiting) before you dispatch the next set of prompts or prompt any agent again. Do not dispatch follow-up prompts or intermediate tasks dynamically while other agents are still actively working. Analyze the collective output of all completed agents before issuing the next coordinated prompts.
18. **CONTEXT-AWARE TERMINAL SUITABILITY**: When deciding which remaining active agents to prompt, analyze which agent's terminal context (their history, tools, and written files) is most suitable for the sub-task, rather than routing tasks arbitrarily or showing favoritism to a single terminal.
19. **ISOLATED AGENTS PROTOCOL**: Remember that terminal sessions/agents are completely isolated. They do not share memory, context, or terminal history. They cannot communicate, coordinate, or wait for one another. You (the Orchestrator) are the sole dispatcher and data router. If Agent B needs information from Agent A's work, you must wait for Agent A to finish, extract Agent A's output from the chat context, and explicitly paste it into the prompt you send to Agent B. ⚠️ **CRITICAL: NEVER tell an agent to look at the terminal history, console transcripts, or output of another agent. They have NO access to them. You (the Orchestrator) MUST copy the completed text/findings from your context and paste it into the prompt yourself.**

## Installed Skills
These are custom agent capabilities installed in the workspace. If any of these are relevant to the user request, you should direct your CLI agents to apply/use them. For example, instruct the spawned CLI agent to follow the instructions in the attached skill block.
${skillsList}

## Session Context Window
${contextWindow || "(no prior session context)"}

## Current Agent Output
${outputBlocks || "(no output captured yet)"}

## Pending Agent Questions
${questionBlocks || "(none)"}

## Recent Tool Calls
${recentTools || "(none)"}`;
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

function buildPlanPrompt(
  contextWindow = "",
  changedFiles: ChatDiffFile[] = [],
  installedSkills: InstalledSkill[] = [],
): string {
  const changed = changedFiles.slice(0, 14)
    .map(file => `- ${file.status}: ${file.path}`)
    .join("\n");

  const skillsList = installedSkills.length > 0
    ? installedSkills.map(s => `- **${s.name}** (\`${s.slug}\`): ${s.description}\n  Triggers: ${s.triggers.join(", ")}`).join("\n")
    : "(none installed — tell the user they can browse/install skills from the Skills tab)";

  return `You are the planning mode inside Integraded Chat.

Create a practical implementation plan for the user's request. This mode is handled entirely in chat:
- Do not call CLI agents.
- Do not emit tool calls.
- Do not ask another agent to do work.
- Produce a concise but practical plan with concrete files, phases, risks, and verification steps.
- If the user mentioned files with @filename, use the attached file contents/paths in your plan.
- End by asking whether the user wants this plan saved as a Markdown implementation file.

Preferred structure:
## Goal
## Implementation Plan
## Files To Touch
## Verification
## Risks / Questions

## Installed Skills
The following custom capabilities are installed. You can reference them in your implementation plan if relevant:
${skillsList}

## Current Chat Context
${contextWindow || "(no prior session context)"}

## Current Diff Snapshot
${changed || "(no changed files detected)"}`;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function compactText(value: string, limit = 900): string {
  const clean = stripAgentTags(value || "").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

function safeStorageScope(value: string): string {
  const clean = (value || "default")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return clean || "default";
}

function normalizeMessages(raw: any): Msg[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(msg => msg && typeof msg === "object")
    .filter(msg => msg.agent !== "diff") as Msg[];
}

export function summarySignature(text: string): string {
  return compactText(
    stripAnsi(text)
      .toLowerCase()
      .replace(/[^a-z0-9 .,;:!?()[\]{}@#%&+=_\-/\\|<>]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    360,
  );
}

function looksLikeTerminalNoise(text: string): boolean {
  const compact = stripAnsi(text).replace(/\s/g, "");
  if (compact.length < 24) return false;
  if (/[█▄▀▌▐░▒▓■□▪▫●○◆◇]{2,}/.test(compact)) return true;
  const unusual = compact.replace(/[a-zA-Z0-9.,:;!?()[\]{}'"`@#%&+=_\-/\\|<>~$*]/g, "").length;
  return unusual / compact.length > 0.34;
}

function extractLocalUrls(outputs: Record<string, string>): string[] {
  const text = Object.values(outputs).join("\n");
  const matches = text.match(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s'"<>)]*/gi) || [];
  return Array.from(new Set(matches.map(raw =>
    raw.replace(/^http:\/\/0\.0\.0\.0/i, "http://127.0.0.1").replace(/^https:\/\/0\.0\.0\.0/i, "https://127.0.0.1")
  ))).slice(0, 4);
}

export function buildAgentsReadySummary(
  monitor: WorkMonitor,
  sessions: Session[],
  outputs: Record<string, string>,
  changedFiles: ChatDiffFile[],
): string {
  const labelsList = monitor.sessionIds
    .map(sid => sessions.find(s => s.sessionId === sid)?.label)
    .filter(Boolean) as string[];
  const labels = labelsList.length ? labelsList.join(", ") : `${monitor.actions} agent action${monitor.actions === 1 ? "" : "s"}`;
  const files = changedFiles.slice(0, 10).map(file => `- ${file.status === "new" ? "NEW" : "MOD"} ${file.name}`);
  const urls = extractLocalUrls(outputs).map(url => `- ${url}`);
  const active = sessions.map(s => `- ${s.label} (${s.status || "unknown"})`).slice(0, 8);
  return [
    "**Agents finished** — reviewing output…",
    "",
    `**Coordinated work**: ${labels}`,
    active.length ? `\n**Sessions**\n${active.join("\n")}` : "",
    files.length ? `\n**Changed files**\n${files.join("\n")}${changedFiles.length > files.length ? `\n- ...and ${changedFiles.length - files.length} more` : ""}` : "",
    urls.length ? `\n**Local preview**\n${urls.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

function formatAttachmentsForPrompt(attachments?: ChatAttachment[]): string {
  if (!attachments?.length) return "";
  return attachments.map(att => {
    const bits = [`${att.type}: ${att.name}`];
    if (att.path) bits.push(`path=${att.path}`);
    if (att.detail) bits.push(`detail=${att.detail}`);
    if (att.url && att.url.startsWith("data:")) bits.push("inline image attached in chat UI");
    const content = att.content
      ? `\n  File content:\n${att.content.split("\n").map(line => `  ${line}`).join("\n")}`
      : "";
    return `- ${bits.join(" | ")}${content}`;
  }).join("\n");
}

function messageForModel(msg: Msg): string {
  let content = stripAgentTags(msg.body || "");
  const attachmentContext = formatAttachmentsForPrompt(msg.attachments);
  if (attachmentContext) content += `\n\nAttachments:\n${attachmentContext}`;
  if (msg.toolLog) {
    const note = msg.toolLog.note || msg.toolLog.action.prompt || msg.toolLog.action.reason || msg.toolLog.action.url || "";
    content += `\n\nTool log: ${msg.toolLog.action.type} ${msg.toolLog.action.label} ${msg.toolLog.status}${note ? ` - ${note}` : ""}`;
  }
  if (msg.diffLog) {
    content += `\n\nDiff log:\n${formatDiffLogBody(msg.diffLog)}`;
  }
  if (msg.skillLog) {
    const names = msg.skillLog.skills.map(s => s.name).join(", ");
    const target = msg.skillLog.agentLabel !== "chat" ? ` → ${msg.skillLog.agentLabel}` : "";
    content += `\n\nSkill log: ${msg.skillLog.status} [${names}]${target}`;
  }
  return content.trim();
}

function appendContextWindow(current: string, msg: Msg): string {
  if (msg.streaming) return current;
  const label = msg.role === "user" ? "User" : msg.agent === "tool" ? "Tool" : msg.agent === "diff" ? "Diff" : msg.agent === "system" ? "System" : "Assistant";
  const content = compactText(messageForModel(msg), msg.role === "user" ? 1000 : 1200);
  if (!content) return current;
  const line = `[${msg.ts}] ${label}: ${content}`;
  return `${current ? `${current}\n` : ""}${line}`.slice(-18000);
}

function formatToolLogBody(log: ToolCallLog): string {
  const note = log.note || log.action.prompt || log.action.reason || log.action.url || log.action.question || "Queued";
  const target = log.action.type === "browser_open" ? (log.action.url || log.action.label) : log.action.label;
  return `Tool call - ${log.action.type} -> ${target}\nStatus: ${log.status}${note ? `\n${compactText(note, 420)}` : ""}`;
}

function chatFolderName(createdAt: number, id: string): string {
  const iso = new Date(createdAt)
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replace(/[:T]/g, "-");
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(-10);
  return `${iso}_${safeId}`;
}

function createChatMeta(): ChatSessionMeta {
  const createdAt = Date.now();
  const id = `h${createdAt}-${Math.random().toString(36).slice(2, 6)}`;
  return { id, createdAt, folderName: chatFolderName(createdAt, id) };
}

function normalizeHistory(raw: any): ChatHistory | null {
  if (!raw || !Array.isArray(raw.msgs)) return null;
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : Date.now();
  const id = typeof raw.id === "string" ? raw.id : `h${createdAt}`;
  const msgs = normalizeMessages(raw.msgs);
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : "Chat",
    msgs,
    contextWindow: typeof raw.contextWindow === "string" ? raw.contextWindow : "",
    createdAt,
    folderName: typeof raw.folderName === "string" ? raw.folderName : chatFolderName(createdAt, id),
  };
}

function diffSignature(files: ChatDiffFile[]): string {
  return files
    .map(file => `${file.status}:${file.path}`)
    .sort()
    .join("|");
}

function formatDiffLogBody(log: DiffLog): string {
  const preview = log.files.slice(0, 6).map(file => `${file.status}: ${file.path}`).join("\n");
  const more = log.total > log.files.length ? `\n...and ${log.total - log.files.length} more` : "";
  return `Diff view updated\n${preview}${more}`;
}

function toolLogTarget(log: ToolCallLog): string {
  if (log.action.type === "browser_open") return log.action.url || log.action.label;
  if (log.action.type === "request") return `${log.action.count || 1} ${log.action.agentType || "agent"}`;
  if (log.action.type === "mode") return `${log.action.label} -> ${log.action.agentType || log.action.mode || "mode"}`;
  return log.action.label;
}

function toolLogNote(log: ToolCallLog): string {
  const raw = log.note || log.action.prompt || log.action.reason || log.action.url || log.action.question || "";
  if (/^sent to\b/i.test(raw.trim())) return "";
  return compactText(raw, 360);
}

function isAffirmative(value: string): boolean {
  return /^(ano|jo|jasne|jasně|yes|y|ok|okay|sure|vytvor|vytvoř|create|save)\b/i.test(value.trim());
}

function isNegative(value: string): boolean {
  return /^(ne|no|n|skip|preskoc|přeskoč|nevytvaret|nevytvářet)\b/i.test(value.trim());
}

function joinWorkspacePath(workspaceDir: string, fileName: string): string {
  return `${workspaceDir.replace(/[\\/]+$/, "")}/${fileName}`;
}

function cleanMentionToken(raw: string): string {
  return raw
    .trim()
    .replace(/^[@`"'\[]+|[`"',.!?\]]+$/g, "")
    .replace(/^\.\//, "")
    .trim();
}

function normalizeMentionPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

function fileBaseName(name: string): string {
  return name.replace(/\.[^.]+$/, "").toLowerCase();
}

function parseFileMentions(text: string, files: MentionFile[]): ChatAttachment[] {
  if (!text.includes("@")) return [];
  const mentionRegex = /(?:^|[\s([{])@(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s,;:)]+))/g;
  const tokens = Array.from(text.matchAll(mentionRegex))
    .map(m => cleanMentionToken(m[1] || m[2] || m[3] || m[4] || ""))
    .filter(Boolean);
  const found: ChatAttachment[] = [];
  const used = new Set<string>();
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const wantedPath = normalizeMentionPath(token);
    const wantedBase = fileBaseName(lower.split(/[\\/]/).pop() || lower);
    const match = files
      .map(file => {
        const path = normalizeMentionPath(file.path);
        const name = file.name.toLowerCase();
        const base = fileBaseName(file.name);
        let score = 0;
        if (path === wantedPath) score = 100;
        else if (name === lower) score = 92;
        else if (base === wantedBase) score = 84;
        else if (path.endsWith(`/${wantedPath}`) || path.endsWith(wantedPath)) score = 76;
        else if (path.includes(wantedPath) && wantedPath.length >= 4) score = 52;
        else if (name.includes(lower) && lower.length >= 3) score = 42;
        return { file, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.file;
    if (match && !used.has(match.path)) {
      used.add(match.path);
      found.push({
        id: `file-${Date.now()}-${found.length}`,
        type: "file",
        name: match.name,
        path: match.path,
        detail: `Mentioned by @${token}`,
      });
    } else if (!match && !used.has(`unresolved:${token}`)) {
      used.add(`unresolved:${token}`);
      found.push({
        id: `file-missing-${Date.now()}-${found.length}`,
        type: "file",
        name: token,
        detail: `Unresolved @${token} mention. Agent should locate this file in the workspace before editing.`,
      });
    }
  }
  return found;
}

const MAX_MENTION_FILE_CHARS = 14000;

async function hydrateFileMentionAttachments(attachments: ChatAttachment[]): Promise<ChatAttachment[]> {
  return Promise.all(attachments.map(async att => {
    if (att.type !== "file" || !att.path || att.content) return att;
    try {
      const raw = await invoke<string>("read_file_content", { filePath: att.path });
      const clipped = raw.length > MAX_MENTION_FILE_CHARS
        ? `${raw.slice(0, MAX_MENTION_FILE_CHARS)}\n\n[File clipped after ${MAX_MENTION_FILE_CHARS} characters.]`
        : raw;
      return {
        ...att,
        mime: att.mime || "text/plain",
        detail: `${att.detail || "Mentioned file"}; content included for agent context`,
        content: clipped,
      };
    } catch (err) {
      return {
        ...att,
        detail: `${att.detail || "Mentioned file"}; content could not be read: ${String(err)}`,
      };
    }
  }));
}

// ─── ChatPanel ────────────────────────────────────────────────────────────────

export const ChatPanel: React.FC<{
  embedded?: boolean;
  workspaceDir?: string;
  sessions?: Session[];
  terminalOutputs?: Record<string, string>;
  terminalTranscripts?: Record<string, TerminalTranscriptEntry[]>;
  externalPrompt?: ExternalChatPrompt | null;
  chatStorageScope?: string;
  mentionFiles?: MentionFile[];
  changedFiles?: ChatDiffFile[];
  onSendPtyCommand?: (sessId: string, cmd: string) => void;
  onAddSession?: (label: string, command: string) => Session;
  onCloseSession?: (id: number) => void;
  onRestartSession?: (id: number) => string;
  onChangeSessionAgent?: (id: number, label: string, command: string, restart?: boolean) => string | void;
  onOpenBrowser?: (request: BrowserOpenRequest) => void;
  onOpenDiffFile?: (path: string, name: string) => void;
}> = ({
  embedded,
  workspaceDir = "",
  sessions: sessionsProp = [],
  terminalOutputs: terminalOutputsProp = {},
  terminalTranscripts: terminalTranscriptsProp = {},
  externalPrompt,
  chatStorageScope,
  mentionFiles = [],
  changedFiles = [],
  onSendPtyCommand,
  onAddSession,
  onCloseSession,
  onRestartSession,
  onChangeSessionAgent,
  onOpenBrowser,
  onOpenDiffFile,
}) => {
  const chatScopeKey = safeStorageScope(chatStorageScope || workspaceDir || "default");
  const storageKey = (name: string) => `integraded_chat_${chatScopeKey}_${name}`;

  // ── Core state ───────────────────────────────────────────────────────────────
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try {
      const stored = localStorage.getItem(storageKey("current_msgs"));
      return stored ? normalizeMessages(JSON.parse(stored)) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [mentionSuggestions, setMentionSuggestions] = useState<MentionFile[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [contextWindow, setContextWindow] = useState<string>(() => {
    try { return localStorage.getItem(storageKey("context_window")) || ""; } catch { return ""; }
  });
  const [composerAttachments, setComposerAttachments] = useState<ChatAttachment[]>([]);
  const [imagePreview, setImagePreview] = useState<ChatAttachment | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCallLog[]>(() => {
    try {
      const stored = localStorage.getItem(storageKey("tool_calls"));
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [agentQuestions, setAgentQuestions] = useState<AgentQuestion[]>([]);
  const [pendingAgentRequests, setPendingAgentRequests] = useState<PendingAgentRequest[]>([]);
  const hasRunningTool = toolCalls.some(t => t.status === "running" || t.status === "queued" || t.status === "waiting");

  // ── Chat history ─────────────────────────────────────────────────────────────
  const [histories, setHistories] = useState<ChatHistory[]>(() => {
    try {
      const stored = localStorage.getItem(storageKey("histories"));
      return stored ? (JSON.parse(stored) || []).map(normalizeHistory).filter(Boolean) as ChatHistory[] : [];
    } catch {
      return [];
    }
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyHydrated, setHistoryHydrated] = useState(false);
  const [lastSeenHistoryCount, setLastSeenHistoryCount] = useState<number>(() => {
    try {
      const stored = localStorage.getItem("integraded_chat_default_last_seen_history_count");
      if (stored !== null) return parseInt(stored, 10);
    } catch {}
    return 0;
  });
  const [currentChatMeta, setCurrentChatMeta] = useState<ChatSessionMeta>(() => createChatMeta());
  const historyRef = useRef<HTMLDivElement>(null);

  // ── Terminal picker ──────────────────────────────────────────────────────────
  const [termPickerOpen, setTermPickerOpen] = useState(false);
  const [termCustomOpen, setTermCustomOpen] = useState(false);
  const [termCustomLabel, setTermCustomLabel] = useState("");
  const [termCustomCommand, setTermCustomCommand] = useState("");
  const termPickerRef = useRef<HTMLDivElement>(null);

  // ── Model selection ──────────────────────────────────────────────────────────
  const [config, setConfig] = useState<any>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;
  const [selectedCloudProvider, setSelectedCloudProvider] = useState("openai");
  const [streamingEnabled, setStreamingEnabled] = useState(true);
  const [thinkingPreviewEnabled, setThinkingPreviewEnabled] = useState(true);
  // "ask" = Accept Only (default), "bypass" = execute tools without confirmation
  const [chatToolMode, setChatToolMode] = useState<"ask" | "bypass">("ask");
  // Pending tool approvals: id → executor function
  const pendingApprovalsRef = useRef<Map<string, () => void>>(new Map());
  const [chatMode, setChatMode] = useState<"build" | "plan">("build");
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  // ── Installed skills ───────────────────────────────────────────────────────
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const installedSkillsRef = useRef<InstalledSkill[]>([]);

  const [disabledProviders, setDisabledProviders] = useState<Set<string>>(new Set());
  const disabledProvidersRef = useRef<Set<string>>(new Set());

  // Local provider models (Ollama / LM Studio) stored separately to prevent
  // the cloud-merge effect from accidentally wiping them on each cloudModels update.
  const [localModels, setLocalModels] = useState<ModelEntry[]>([]);
  // Tracks reachability of local servers so the dropdown can show online/offline status.
  const [localProviderOnline, setLocalProviderOnline] = useState<Record<string, boolean>>({});

  /** Select a model and persist immediately to config.json */
  const selectModel = (value: string, provider: string) => {
    setSelectedModel(value);
    setSelectedCloudProvider(provider);
    invoke("save_active_model", { model: value, provider }).catch(() => {});
  };

  const [cloudModels, setCloudModels] = useState<ModelEntry[]>([]);
  // Cache: provider → fetched entries (undefined = not yet fetched).
  // Cleared fully on every config change so stale/failed results are retried.
  const cloudModelCacheRef = useRef<Partial<Record<string, ModelEntry[]>>>({});
  // Increment to force a full model re-fetch without changing config.
  const [modelRefreshTick, setModelRefreshTick] = useState(0);
  const [modelRefreshing, setModelRefreshing] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const pillBtnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{top:number;left:number} | null>(null);
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const modeBtnRef = useRef<HTMLButtonElement>(null);
  const [modeDropdownPos, setModeDropdownPos] = useState<{top:number;left:number} | null>(null);

  // ── Refs ─────────────────────────────────────────────────────────────────────
  const endRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const streamUnlistenRef = useRef<(() => void) | null>(null);
  const streamTextRef = useRef("");
  const streamThinkingRef = useRef("");
  const streamThinkingStartRef = useRef<number | null>(null);
  const streamThinkingElapsedRef = useRef<number | null>(null);
  const activeStreamIdRef = useRef<string | null>(null);
  const [chatAtBottom, setChatAtBottom] = useState(true);
  const chatAtBottomRef = useRef(true);
  const [workMonitor, setWorkMonitor] = useState<WorkMonitor | null>(null);
  const workMonitorRef = useRef<WorkMonitor | null>(null);
  // Timestamp set when agents finish so the auto-resume useEffect can trigger.
  const [pendingAutoResume, setPendingAutoResume] = useState<number | null>(null);
  // Timestamp set when unanswered agent questions appear — triggers auto-answer.
  const [pendingAutoAnswer, setPendingAutoAnswer] = useState<number | null>(null);
  const isProcessingRef = useRef(isProcessing);

  const onSendPtyCommandRef = useRef(onSendPtyCommand);
  const onAddSessionRef = useRef(onAddSession);
  const onCloseSessionRef = useRef(onCloseSession);
  const onRestartSessionRef = useRef(onRestartSession);
  const onChangeSessionAgentRef = useRef(onChangeSessionAgent);
  const onOpenBrowserRef = useRef(onOpenBrowser);
  const sessionsRef = useRef(sessionsProp);
  const terminalOutputsRef = useRef(terminalOutputsProp);
  const terminalTranscriptsRef = useRef(terminalTranscriptsProp);
  const toolCallsRef = useRef<ToolCallLog[]>([]);
  const agentQuestionsRef = useRef<AgentQuestion[]>([]);
  const pendingAgentRequestsRef = useRef<PendingAgentRequest[]>([]);
  const contextWindowRef = useRef(contextWindow);
  const mentionFilesRef = useRef(mentionFiles);
  const changedFilesRef = useRef(changedFiles);
  /** Skills matched from the current user message — shared with terminal dispatch. */
  const currentTaskSkillsRef = useRef<InstalledSkill[]>([]);
  /** Workspace file paths written for current task's skills (empty if workspaceDir unset). */
  const currentTaskSkillFilePathsRef = useRef<string[]>([]);

  const seenQuestionKeysRef = useRef<Set<string>>(new Set());
  // const seenSummaryKeysRef = useRef<Set<string>>(new Set());
  const lastSummaryBySessionRef = useRef<Record<string, { sig: string; at: number }>>({});
  const lastDiffSignatureRef = useRef("");
  const lastReadySummaryRef = useRef("");
  const usedPromptSessionIdsRef = useRef<Set<string>>(new Set());
  const handledExternalPromptRef = useRef<string | null>(null);
  const lastContextMsgIdRef = useRef<string | null>(null);
  const currentChatMetaRef = useRef(currentChatMeta);
  const pendingDirectActionsCountRef = useRef(0);
  
  onSendPtyCommandRef.current = onSendPtyCommand;
  onAddSessionRef.current = onAddSession;
  onCloseSessionRef.current = onCloseSession;
  onRestartSessionRef.current = onRestartSession;
  onChangeSessionAgentRef.current = onChangeSessionAgent;
  onOpenBrowserRef.current = onOpenBrowser;
  sessionsRef.current = sessionsProp;
  terminalOutputsRef.current = terminalOutputsProp;
  terminalTranscriptsRef.current = terminalTranscriptsProp;
  toolCallsRef.current = toolCalls;
  agentQuestionsRef.current = agentQuestions;
  pendingAgentRequestsRef.current = pendingAgentRequests;
  contextWindowRef.current = contextWindow;
  mentionFilesRef.current = mentionFiles;
  changedFilesRef.current = changedFiles;
  currentChatMetaRef.current = currentChatMeta;
  workMonitorRef.current = workMonitor;
  isProcessingRef.current = isProcessing;
  installedSkillsRef.current = installedSkills;
  disabledProvidersRef.current = disabledProviders;

  const decrementPendingDirectActions = useCallback(() => {
    pendingDirectActionsCountRef.current = Math.max(0, pendingDirectActionsCountRef.current - 1);
    if (pendingDirectActionsCountRef.current === 0 && !workMonitorRef.current) {
      setPendingAutoResume(Date.now());
    }
  }, []);

  const updateChatAtBottom = () => {
    const el = messagesRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
    chatAtBottomRef.current = atBottom;
    setChatAtBottom(atBottom);
  };

  const scrollChatToBottom = (behavior: ScrollBehavior = "smooth") => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    chatAtBottomRef.current = true;
    setChatAtBottom(true);
  };

  // ── Effects ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (chatAtBottomRef.current || isProcessing || hasRunningTool || !!workMonitor) {
      requestAnimationFrame(() => scrollChatToBottom("smooth"));
    }
    requestAnimationFrame(() => {
      const bodies = chatPanelRef.current?.querySelectorAll<HTMLElement>(".chat-thinking.open .chat-thinking-body");
      bodies?.forEach(body => {
        body.scrollTop = body.scrollHeight;
      });
    });
  }, [msgs, isProcessing, hasRunningTool, workMonitor]);

  useEffect(() => {
    const last = msgs[msgs.length - 1];
    if (!last || last.streaming || lastContextMsgIdRef.current === last.id) return;
    lastContextMsgIdRef.current = last.id;
    setContextWindow(prev => appendContextWindow(prev, last));
  }, [msgs]);

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
      const inModePill = modeDropdownRef.current?.contains(target);
      const inModeDropdown = (target as Element)?.closest?.('[data-mode-dropdown]');
      if (!inModePill && !inModeDropdown) setModeDropdownOpen(false);

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
      setThinkingPreviewEnabled(loaded.thinking_preview ?? true);
      if (loaded.cloud_provider) setSelectedCloudProvider(loaded.cloud_provider);
      if (loaded.active_model) setSelectedModel(loaded.active_model);
      // Persist disabled provider list
      if (Array.isArray(loaded.disabled_providers)) {
        setDisabledProviders(new Set(loaded.disabled_providers as string[]));
      }
      if (loaded.chat_tool_mode === "bypass" || loaded.chat_tool_mode === "ask") {
        setChatToolMode(loaded.chat_tool_mode);
      }
    } catch {}
  };
  useEffect(() => {
    loadConfig();
    window.addEventListener("__integradedConfigUpdated", loadConfig);
    return () => window.removeEventListener("__integradedConfigUpdated", loadConfig);
  }, [chatScopeKey]);

  useEffect(() => {
    setHistoryHydrated(false);
    let active = true;
    (async () => {
      let loadedHistories: ChatHistory[] = [];
      try {
        // 1. Load the global histories list
        const rawGlobal = await invoke<string | null>("load_chat_history", { scope: "default" });
        if (!active) return;
        
        if (rawGlobal) {
          const payload = JSON.parse(rawGlobal);
          loadedHistories = Array.isArray(payload.histories)
            ? payload.histories.map(normalizeHistory).filter(Boolean) as ChatHistory[]
            : [];
        } else {
          // Fallback to global localStorage for histories
          try {
            const stored = localStorage.getItem("integraded_chat_default_histories");
            if (stored) {
              loadedHistories = (JSON.parse(stored) || []).map(normalizeHistory).filter(Boolean) as ChatHistory[];
            }
          } catch {}
        }
        setHistories(loadedHistories);

        // 2. Load the workspace-scoped active session
        const rawWorkspace = await invoke<string | null>("load_chat_history", { scope: chatScopeKey });
        if (!active) return;
        
        // Reset active session questions/requests for the new scope
        setAgentQuestions([]);
        setPendingAgentRequests([]);
        setWorkMonitor(null);

        if (rawWorkspace) {
          const payload = JSON.parse(rawWorkspace);
          if (payload.current_session) {
            const current = normalizeHistory(payload.current_session);
            if (current) {
              setCurrentChatMeta({
                id: current.id,
                createdAt: current.createdAt,
                folderName: current.folderName || chatFolderName(current.createdAt, current.id),
              });
              const cleanMsgs = normalizeMessages(current.msgs || []);
              setMsgs(cleanMsgs);
              setContextWindow(current.contextWindow || cleanMsgs.reduce((ctx, msg) => appendContextWindow(ctx, msg), ""));
            }
          } else if (Array.isArray(payload.current_msgs)) {
            const cleanMsgs = normalizeMessages(payload.current_msgs);
            setMsgs(cleanMsgs);
            setContextWindow(typeof payload.current_context === "string" ? payload.current_context : "");
            setCurrentChatMeta(createChatMeta());
          } else {
            setMsgs([]);
            setContextWindow("");
            setCurrentChatMeta(createChatMeta());
          }
        } else {
          // Fallback to scope-specific localStorage for current session
          try {
            const storedMsgs = localStorage.getItem(storageKey("current_msgs"));
            const storedContext = localStorage.getItem(storageKey("context_window"));
            const storedTools = localStorage.getItem(storageKey("tool_calls"));
            
            const cleanMsgs = storedMsgs ? normalizeMessages(JSON.parse(storedMsgs)) : [];
            setMsgs(cleanMsgs);
            setContextWindow(storedContext || "");
            setToolCalls(storedTools ? JSON.parse(storedTools) : []);
            setCurrentChatMeta(createChatMeta());
          } catch {
            setMsgs([]);
            setContextWindow("");
            setToolCalls([]);
            setCurrentChatMeta(createChatMeta());
          }
        }
      } catch {
        // Fallback offline resets
        setMsgs([]);
        setContextWindow("");
        setToolCalls([]);
        setCurrentChatMeta(createChatMeta());
      } finally {
        if (active) {
          const initialCount = loadedHistories.length;
          setLastSeenHistoryCount(initialCount);
          try {
            localStorage.setItem("integraded_chat_default_last_seen_history_count", String(initialCount));
          } catch {}
          setHistoryHydrated(true);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [chatScopeKey]);

  // Adjust lastSeenHistoryCount downward if history items are deleted or cleared
  useEffect(() => {
    if (!historyHydrated) return;
    const totalCount = histories.length;
    if (totalCount < lastSeenHistoryCount) {
      setLastSeenHistoryCount(totalCount);
      try {
        localStorage.setItem("integraded_chat_default_last_seen_history_count", String(totalCount));
      } catch {}
    }
  }, [histories.length, lastSeenHistoryCount, historyHydrated]);

  // ── Persistence helpers ───────────────────────────────────────────────────────

  // Persistence synchronizations
  useEffect(() => {
    if (!historyHydrated) return;
    // Skip while any message is streaming — msgs changes on every token, so
    // writing to disk/localStorage each time causes unnecessary I/O.
    // The effect re-fires once streaming ends and the final state is persisted.
    if (msgs.some(m => m.streaming)) return;
    try {
      localStorage.setItem(storageKey("current_msgs"), JSON.stringify(normalizeMessages(msgs)));
    } catch {}

    // Save only current active session to the workspace-scoped file
    const cleanMsgs = normalizeMessages(msgs);
    const currentName = cleanMsgs.find(m => m.role === "user")?.body.slice(0, 60) || "Current chat";
    const payload = JSON.stringify({
      current_msgs: cleanMsgs,
      current_context: contextWindow,
      current_session: {
        ...currentChatMetaRef.current,
        name: currentName,
        msgs: cleanMsgs,
        contextWindow: contextWindow,
      },
    });
    invoke("save_chat_history", { jsonData: payload, scope: chatScopeKey }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs, contextWindow, historyHydrated, chatScopeKey]);

  useEffect(() => {
    if (!historyHydrated) return;
    try {
      localStorage.setItem("integraded_chat_default_histories", JSON.stringify(histories));
    } catch {}
    
    // Save only histories list to the global store
    const payload = JSON.stringify({
      histories: histories.map(h => ({ ...h, msgs: normalizeMessages(h.msgs) })),
    });
    invoke("save_chat_history", { jsonData: payload, scope: "default" }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histories, historyHydrated]);

  useEffect(() => {
    try { localStorage.setItem(storageKey("context_window"), contextWindow); } catch {}
  }, [contextWindow, chatScopeKey]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey("tool_calls"), JSON.stringify(toolCalls.slice(0, 80)));
    } catch {}
  }, [toolCalls, chatScopeKey]);

  useEffect(() => {
    const handleClear = () => {
      setMsgs([]);
      setContextWindow("");
      setComposerAttachments([]);
      setHistories([]);
      setToolCalls([]);
      setAgentQuestions([]);
      setPendingAgentRequests([]);
      setCurrentChatMeta(createChatMeta());
      setWorkMonitor(null);
      lastDiffSignatureRef.current = "";
      lastReadySummaryRef.current = "";
      lastSummaryBySessionRef.current = {};
    };
    window.addEventListener("__integradedChatHistoryCleared", handleClear);
    return () => window.removeEventListener("__integradedChatHistoryCleared", handleClear);
  }, []);

  // ── Cloud model fetching ───────────────────────────────────────────────────
  // Runs on config change OR manual refresh tick. Clears cache so all providers
  // are re-fetched fresh. Each provider updates cloudModels as soon as it resolves.
  useEffect(() => {
    if (!config) return;

    cloudModelCacheRef.current = {};
    setModelRefreshing(true);

    const CLOUD_PROVIDERS_IDS = Object.keys(PROVIDER_NAMES);
    const keys = config.api_keys || {};
    const toFetch = CLOUD_PROVIDERS_IDS.filter(prov => keys[prov] && (keys[prov] as string).length > 5);
    if (toFetch.length === 0) { setModelRefreshing(false); return; }

    let resolved = 0;
    toFetch.forEach(async (prov) => {
      try {
        const fetched = await invoke<{ id: string; name: string }[]>(
          "fetch_provider_models", { provider: prov }
        );
        cloudModelCacheRef.current[prov] = fetched.map(m => ({
          value: m.id,
          label: m.name || m.id,
          provider: prov,
          providerName: PROVIDER_NAMES[prov] || prov,
          type: "cloud" as const,
        }));
      } catch (err) {
        console.error(`[models] fetch failed for ${prov}:`, err);
        cloudModelCacheRef.current[prov] = [];
      }
      const all = CLOUD_PROVIDERS_IDS.flatMap(p => cloudModelCacheRef.current[p] || []);
      setCloudModels(all);
      resolved++;
      if (resolved === toFetch.length) setModelRefreshing(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, modelRefreshTick]);

  // ── Local provider polling (LM Studio + Ollama) ────────────────────────────
  // Poll every 5 s. Results go into localModels state which is merged cleanly
  // by the effect below — no risk of being overwritten by cloudModels updates.
  useEffect(() => {
    if (!config) return;
    const pollLocal = async () => {
      const local: ModelEntry[] = [];
      const online: Record<string, boolean> = {};
      try {
        const lmUrl = (config.lmstudio_url || "http://localhost:1234").replace(/\/+$/, "");
        const d = JSON.parse(await invoke<string>("curl_get", { url: `${lmUrl}/v1/models` }));
        for (const m of d.data) local.push({ value: m.id, label: m.id, provider: "lmstudio", providerName: "LM Studio", type: "local" });
        online.lmstudio = true;
      } catch { online.lmstudio = false; }
      try {
        const olUrl = (config.ollama_url || "http://localhost:11434").replace(/\/+$/, "");
        const d = JSON.parse(await invoke<string>("curl_get", { url: `${olUrl}/api/tags` }));
        for (const m of d.models) local.push({ value: m.name, label: m.name, provider: "ollama", providerName: "Ollama", type: "local" });
        online.ollama = true;
      } catch { online.ollama = false; }
      setLocalModels(local);
      setLocalProviderOnline(online);
    };
    pollLocal();
    const t = setInterval(pollLocal, 20000);
    return () => clearInterval(t);
  }, [config]);

  // ── Merge cloud + local into the combined models list ─────────────────────
  useEffect(() => {
    const visibleCloud = cloudModels.filter(m => !disabledProvidersRef.current.has(m.provider));
    const merged = [...visibleCloud, ...localModels];
    // Auto-select first model only when there is no saved selection (e.g. first
    // launch). If a model is already saved, leave it alone — its provider may
    // still be loading and would appear once the fetch completes.
    if (!selectedModelRef.current && merged.length > 0) {
      selectModel(merged[0].value, merged[0].provider);
    }
    setModels(merged);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudModels, localModels, disabledProviders]);

  // ── Load installed skills (and refresh when user installs/uninstalls) ────────
  useEffect(() => {
    const load = async () => {
      try {
        const skills = await invoke<InstalledSkill[]>("skills_list_installed");
        setInstalledSkills(skills);
      } catch {}
    };
    load();
    window.addEventListener("__integradedSkillsUpdated", load);
    return () => window.removeEventListener("__integradedSkillsUpdated", load);
  }, []);

  // ── Self-load workspace files for @mention — independent of parent prop ──────
  // The parent's mentionFiles comes from baselineSnapshot which loads slowly.
  // We keep our own flat file index so the dropdown is always populated.
  useEffect(() => {
    if (!workspaceDir) return;
    const loadFiles = async () => {
      try {
        interface FileEntry { path: string; name: string; is_dir: boolean; children?: FileEntry[] }
        const entries = await invoke<FileEntry[]>("list_files", { dirPath: workspaceDir });
        const flat: MentionFile[] = [];
        const recurse = (list: FileEntry[]) => {
          for (const e of list) {
            if (e.is_dir) { if (e.children) recurse(e.children); }
            else flat.push({ path: e.path, name: e.name });
          }
        };
        recurse(entries);
        // Merge with parent prop (parent may have newer content for changed files)
        const parentPaths = new Set(mentionFilesRef.current.map(f => f.path));
        const combined = [...mentionFilesRef.current, ...flat.filter(f => !parentPaths.has(f.path))];
        mentionFilesRef.current = combined;
      } catch {}
    };
    loadFiles();
    const id = window.setInterval(loadFiles, 30000);
    return () => window.clearInterval(id);
  }, [workspaceDir]);

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
    return () => {
      try { rec.abort(); } catch {}
      try { rec.stop(); } catch {}
    };
  }, []);

  // Detect CLI-agent questions from terminal transcripts and surface them to chat.
  useEffect(() => {
    const additions: AgentQuestion[] = [];
    for (const session of sessionsProp) {
      const question = detectTerminalQuestion(terminalOutputsProp[session.sessionId] || "");
      if (!question) continue;
      const recentInputs = (terminalTranscriptsProp[session.sessionId] || [])
        .filter(entry => entry.kind === "input")
        .slice(-6)
        .map(entry => entry.text);
      if (recentInputs.some(text => text.includes(question))) continue;
      const key = `${session.sessionId}:${question}`;
      if (seenQuestionKeysRef.current.has(key)) continue;
      seenQuestionKeysRef.current.add(key);
      additions.push({
        id: `aq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sessionId: session.sessionId,
        label: session.label,
        question,
        ts: ts(),
      });
    }
    if (!additions.length) return;
    setAgentQuestions(prev => [...additions, ...prev].slice(0, 20));
    // Silently trigger auto-answer — no visible message until agent finishes.
    // The orchestrator will answer the question directly in the terminal
    // without cluttering the chat with intermediate status updates.
    setTimeout(() => {
      if (!isProcessingRef.current) setPendingAutoAnswer(Date.now());
    }, 1800);
  }, [sessionsProp, terminalOutputsProp]);

  // (Raw terminal summary effect removed — the LLM auto-resume generates proper summaries.)

  // Keep only the latest diff signature here. The full diff belongs in Changes,
  // not in the chat transcript.
  useEffect(() => {
    if (!historyHydrated) return;
    const files = changedFiles.slice(0, 12);
    const signature = diffSignature(files);
    if (signature === lastDiffSignatureRef.current) return;
    lastDiffSignatureRef.current = signature;
  }, [changedFiles, historyHydrated]);

  // Fulfill queued agent requests as soon as the user adds matching terminals.
  useEffect(() => {
    if (!pendingAgentRequestsRef.current.length) return;
    const nextRequests: PendingAgentRequest[] = [];
    for (const request of pendingAgentRequestsRef.current) {
      const fulfilled = [...request.fulfilledSessionIds];
      const matches = sessionsProp.filter(s =>
        commandMatchesAgent(s.command, request.agentType) &&
        !request.existingSessionIds.includes(s.sessionId) &&
        !fulfilled.includes(s.sessionId)
      );
      for (const session of matches) {
        if (fulfilled.length >= request.count) break;
        fulfilled.push(session.sessionId);
        if (request.prompt) {
          sendToSession(session, request.prompt, request.id);
          setWorkMonitor({
            id: `wm-${Date.now()}-${request.id}`,
            startedAt: Date.now(),
            actions: 1,
            sessionIds: [session.sessionId],
          });
        }
      }
      if (fulfilled.length >= request.count) {
        updateToolLog(request.id, "done", `Detected ${fulfilled.length} ${request.agentType} agent${fulfilled.length > 1 ? "s" : ""}.`);
        setMsgs(prev => [...prev, {
          id: `det-${Date.now()}-${request.id}`,
          role: "ai",
          agent: "system",
          body: `Detekoval jsem nově přidané ${request.agentType} agent${fulfilled.length > 1 ? "y" : "a"} a navázal jsem na ně připravený úkol.`,
          ts: ts(),
        }]);
      } else {
        nextRequests.push({ ...request, fulfilledSessionIds: fulfilled });
      }
    }
    setPendingAgentRequests(nextRequests);
  }, [sessionsProp]);

  useEffect(() => {
    if (!workMonitor) return;
    const timer = window.setInterval(() => {
      const transcripts = Object.values(terminalTranscriptsRef.current).flat();
      const relevant = transcripts.filter(entry => entry.ts >= workMonitor.startedAt - 2000);
      
      let lastActivity = workMonitor.startedAt;
      if (relevant.length > 0) {
        lastActivity = Math.max(...relevant.map(entry => entry.ts), workMonitor.startedAt);
      }

      // Check the state of the monitored sessions to dynamically adapt the silence timeout.
      // If any agent is still booting or actively running without presenting a final summary or question,
      // we use a long silence timeout (30 seconds) to prevent premature auto-resumes.
      // If all monitored sessions have either exited, finished (completion summary found), or are waiting
      // for user input (terminal question found), we can use a snappy 6-second timeout.
      const monitoredSessions = sessionsRef.current.filter(s =>
        workMonitor.sessionIds.includes(s.sessionId)
      );

      let allDoneOrWaiting = monitoredSessions.length > 0;
      for (const s of monitoredSessions) {
        if (s.status === "exited") continue;
        if (!s.status || s.status === "booting") {
          allDoneOrWaiting = false;
          break;
        }

        const sessionTranscripts = terminalTranscriptsRef.current[s.sessionId] || [];
        const newTranscripts = sessionTranscripts.filter(entry => entry.ts >= workMonitor.startedAt - 2000);
        const output = newTranscripts.map(entry => entry.text).join("");

        const hasSummary = !!detectAgentCompletionSummary(output);
        const hasQuestion = !!detectTerminalQuestion(output);

        if (!hasSummary && !hasQuestion) {
          allDoneOrWaiting = false;
        }
      }

      const timeoutMs = allDoneOrWaiting ? 1500 : 60000;
      
      if (Date.now() - lastActivity < timeoutMs) return;
      if (agentQuestionsRef.current.some(q => !q.answered)) return;
      if (isProcessingRef.current) return;

      const signature = `${workMonitor.id}:${lastActivity}:${changedFilesRef.current.length}`;
      if (lastReadySummaryRef.current === signature) return;
      lastReadySummaryRef.current = signature;
      setWorkMonitor(null);
      // Trigger auto-resume: the LLM will generate a summary directly if no direct actions are pending.
      if (pendingDirectActionsCountRef.current === 0) {
        setPendingAutoResume(Date.now());
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [workMonitor]);

  // ─── Auto-resume after agents finish ──────────────────────────────────────────
  // When pendingAutoResume is set and we're not already processing, call the LLM
  // with the terminal transcripts in context so it can summarize and continue.
  useEffect(() => {
    if (pendingAutoResume === null || isProcessing) return;
    // Skip if no model is configured — avoids curl errors being surfaced in chat.
    if (!selectedModel || models.length === 0) {
      setPendingAutoResume(null);
      return;
    }
    setPendingAutoResume(null);

    // Build an adaptive continuation prompt based on actual work state
    const currentSessions = sessionsRef.current;
    const currentOutputs = terminalOutputsRef.current;
    const exitedAgents = currentSessions.filter(s => s.status === "exited");
    const activeAgents = currentSessions.filter(s => s.status === "running");
    const fileCount = changedFilesRef.current.length;
    const allOutput = Object.values(currentOutputs).join("\n");
    const hasErrors = /\b(error|exception|failed|fatal|traceback|cannot find|unable to|ENOENT|EACCES|SyntaxError|TypeError|ImportError|ModuleNotFoundError)\b/i.test(allOutput.slice(-2000));

    let continuationPrompt = "Agents are idle. Review the terminal context and assess the state of work.\n\n";

    if (exitedAgents.length > 0) {
      continuationPrompt += `⚠ Exited agents: ${exitedAgents.map(s => s.label).join(", ")}. Check if they completed their task or crashed.\n`;
    }
    if (hasErrors) {
      continuationPrompt += `⚠ Errors detected in terminal output. Diagnose the root cause and decide if the task can continue.\n`;
    }
    if (fileCount > 0) {
      continuationPrompt += `📁 ${fileCount} file${fileCount > 1 ? "s" : ""} changed in workspace.\n`;
    }
    if (activeAgents.length > 0) {
      continuationPrompt += `🟢 Active: ${activeAgents.map(s => s.label).join(", ")}.\n`;
    }

    continuationPrompt += `\nNow:\n`;
    continuationPrompt += `1. Summarize what was completed (files created/modified, features working)\n`;
    continuationPrompt += `2. Identify errors, incomplete work, or blockers\n`;
    continuationPrompt += `3. If work is incomplete or errored, dispatch follow-up tasks immediately via tool calls\n`;
    continuationPrompt += `4. If all complete, give a clean summary with verification/preview steps\n`;
    continuationPrompt += `\nBe decisive — if an agent left a task half-done, send it the next step now.`;

    const runResume = async () => {
      setIsProcessing(true);
      const aiMsgId = `a-resume-${Date.now()}`;
      try {
        const sysPrompt = buildOrchestratorPrompt(
          sessionsRef.current,
          terminalOutputsRef.current,
          terminalTranscriptsRef.current,
          toolCallsRef.current,
          agentQuestionsRef.current,
          contextWindowRef.current,
          installedSkillsRef.current,
        );
        const history = msgs
          .filter(m => (m.role === "user" || m.role === "ai") && !m.streaming)
          .slice(-40)
          .map(m => ({
            role: (m.role === "user" || m.agent !== "orchestrator") ? "user" as const : "assistant" as const,
            content: messageForModel(m),
          }));
        const llmMsgs = [
          { role: "system" as const, content: sysPrompt },
          ...history,
          { role: "user" as const, content: continuationPrompt },
        ];

        if (streamingEnabled) {
          setMsgs(p => [...p, {
            id: aiMsgId,
            role: "ai",
            agent: "orchestrator",
            body: "",
            streaming: true,
            ts: ts(),
          }]);
          await streamLLM(aiMsgId, llmMsgs);
          const finalText = streamTextRef.current;
          const actions = parseAgentActions(finalText);
          const visible = stripAgentTags(finalText);
          setMsgs(p => p.map(m => m.id === aiMsgId
            ? { ...m, streaming: false, body: visible, actions: actions.length ? actions : undefined }
            : m,
          ));
          if (actions.length) autoDispatchActions(actions);
        } else {
          const resp = await callLLM(llmMsgs);
          const actions = parseAgentActions(resp);
          const visible = stripAgentTags(resp);
          setMsgs(p => [...p, {
            id: aiMsgId,
            role: "ai",
            agent: "orchestrator",
            body: visible,
            actions: actions.length ? actions : undefined,
            ts: ts(),
          }]);
          if (actions.length) autoDispatchActions(actions);
        }
      } catch (err: any) {
        // Remove the streaming placeholder if present, then display a user-friendly system error.
        const detail = err?.message || String(err || "Failed to auto-resume.");
        setMsgs(p => [
          ...p.filter(m => m.id !== aiMsgId),
          {
            id: `e-resume-${Date.now()}`,
            role: "ai",
            agent: "system",
            body: `⚠️ **Auto-resume failed:** ${detail}\n\nPress **Please proceed** or try again to continue.`,
            ts: ts(),
          }
        ]);
        console.warn("[auto-resume] failed:", err?.message || String(err));
      } finally {
        setIsProcessing(false);
      }
    };

    void runResume();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoResume, isProcessing]);

  // ─── Auto-answer: LLM answers pending agent questions automatically ────────────
  useEffect(() => {
    if (pendingAutoAnswer === null || isProcessing) return;
    const unanswered = agentQuestionsRef.current.filter(q => !q.answered);
    if (!unanswered.length) { setPendingAutoAnswer(null); return; }
    if (!selectedModel || models.length === 0) { setPendingAutoAnswer(null); return; }
    setPendingAutoAnswer(null);

    const questionContext = unanswered
      .map(q => `- ${q.label}: "${q.question}"`)
      .join("\n");

    const autoAnswerPrompt =
      `The following CLI agent(s) are paused and waiting for a response:\n${questionContext}\n\n` +
      `Review the terminal output and the original user task in your context window. ` +
      `If the answer is clear from context (e.g. "yes, proceed", "overwrite", "use default"), ` +
      `send it directly with agent.send. Be decisive — agents prefer a clear answer over silence. ` +
      `Only use chat.ask_user if the answer genuinely cannot be inferred from context.`;

    const runAutoAnswer = async () => {
      setIsProcessing(true);
      const aiMsgId = `a-autoanswer-${Date.now()}`;
      try {
        const sysPrompt = buildOrchestratorPrompt(
          sessionsRef.current,
          terminalOutputsRef.current,
          terminalTranscriptsRef.current,
          toolCallsRef.current,
          agentQuestionsRef.current,
          contextWindowRef.current,
          installedSkillsRef.current,
        );
        const history = msgs
          .filter(m => (m.role === "user" || m.role === "ai") && !m.streaming)
          .slice(-30)
          .map(m => ({
            role: (m.role === "user" || m.agent !== "orchestrator") ? "user" as const : "assistant" as const,
            content: messageForModel(m)
          }));
        const llmMsgs = [
          { role: "system" as const, content: sysPrompt },
          ...history,
          { role: "user" as const, content: autoAnswerPrompt },
        ];

        if (streamingEnabled) {
          setMsgs(p => [...p, { id: aiMsgId, role: "ai", agent: "orchestrator" as const, body: "", streaming: true, ts: ts() }]);
          await streamLLM(aiMsgId, llmMsgs);
          const finalText = streamTextRef.current;
          const actions = parseAgentActions(finalText);
          const visible = stripAgentTags(finalText);
          setMsgs(p => p.map(m => m.id === aiMsgId
            ? { ...m, streaming: false, body: visible, actions: actions.length ? actions : undefined }
            : m));
          if (actions.length) {
            autoDispatchActions(actions);
            // Mark questions as answered for agents that received a send/broadcast
            const sentLabels = actions
              .filter(a => a.type === "send" || a.type === "broadcast")
              .map(a => a.label.toLowerCase());
            if (sentLabels.length > 0) {
              setAgentQuestions(prev => prev.map(q =>
                sentLabels.some(l => q.label.toLowerCase().includes(l) || l.includes(q.label.toLowerCase()) || l === "all" || l === "*")
                  ? { ...q, answered: true } : q
              ));
            }
          }
        } else {
          const resp = await callLLM(llmMsgs);
          const actions = parseAgentActions(resp);
          const visible = stripAgentTags(resp);
          setMsgs(p => [...p, { id: aiMsgId, role: "ai", agent: "orchestrator" as const, body: visible, actions: actions.length ? actions : undefined, ts: ts() }]);
          if (actions.length) autoDispatchActions(actions);
        }
      } catch (err: any) {
        setMsgs(p => p.filter(m => m.id !== aiMsgId));
        console.warn("[auto-answer] failed:", err?.message || String(err));
      } finally {
        setIsProcessing(false);
      }
    };

    void runAutoAnswer();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoAnswer, isProcessing]);

  const { notifyError } = useNotify();

  const toggleRecording = () => {
    const rec = recognitionRef.current;
    if (!rec) { notifyError("Speech recognition not supported."); return; }
    if (isRecording) rec.stop(); else { rec.lang = navigator.language || "cs-CZ"; rec.start(); }
  };

  const attachFiles = (files: FileList | null) => {
    if (!files?.length) return;
    Array.from(files).slice(0, 6).forEach(file => {
      const base: ChatAttachment = {
        id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: file.type.startsWith("image/") ? "image" : "file",
        name: file.name,
        mime: file.type || "application/octet-stream",
        detail: `${Math.round(file.size / 1024)} KB uploaded in chat composer`,
      };
      if (!file.type.startsWith("image/")) {
        setComposerAttachments(prev => [...prev, base].slice(-8));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setComposerAttachments(prev => [...prev, { ...base, url: String(reader.result || "") }].slice(-8));
      };
      reader.readAsDataURL(file);
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const ts = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // ── Chat history management ───────────────────────────────────────────────────

  const saveAndNewChat = () => {
    if (msgs.length > 0) {
      const cleanMsgs = normalizeMessages(msgs);
      const name = cleanMsgs.find(m => m.role === "user")?.body.slice(0, 60) || "Chat";
      setHistories(prev => [{
        id: currentChatMeta.id,
        name,
        msgs: cleanMsgs,
        contextWindow,
        createdAt: currentChatMeta.createdAt,
        folderName: currentChatMeta.folderName,
      }, ...prev]);
    }
    setMsgs([]);
    setContextWindow("");
    setComposerAttachments([]);
    setImagePreview(null);
    setCurrentChatMeta(createChatMeta());
    lastContextMsgIdRef.current = null;
    lastDiffSignatureRef.current = diffSignature(changedFilesRef.current);
    setAgentQuestions([]);
    setWorkMonitor(null);
    setHistoryOpen(false);
  };

  const loadHistory = (h: ChatHistory) => {
    if (msgs.length > 0) {
      const cleanCurrentMsgs = normalizeMessages(msgs);
      const name = cleanCurrentMsgs.find(m => m.role === "user")?.body.slice(0, 60) || "Chat";
      setHistories(prev => [
        {
          id: currentChatMeta.id,
          name,
          msgs: cleanCurrentMsgs,
          contextWindow,
          createdAt: currentChatMeta.createdAt,
          folderName: currentChatMeta.folderName,
        },
        ...prev.filter(x => x.id !== h.id),
      ]);
    } else {
      setHistories(prev => prev.filter(x => x.id !== h.id));
    }
    const folderName = h.folderName || chatFolderName(h.createdAt, h.id);
    const cleanHistoryMsgs = normalizeMessages(h.msgs);
    setCurrentChatMeta({ id: h.id, createdAt: h.createdAt, folderName });
    setMsgs(cleanHistoryMsgs);
    setContextWindow(h.contextWindow || cleanHistoryMsgs.reduce((ctx, msg) => appendContextWindow(ctx, msg), ""));
    setComposerAttachments([]);
    setImagePreview(null);
    lastContextMsgIdRef.current = cleanHistoryMsgs[cleanHistoryMsgs.length - 1]?.id || null;
    lastDiffSignatureRef.current = diffSignature(changedFilesRef.current);
    setAgentQuestions([]);
    setWorkMonitor(null);
    setHistoryOpen(false);
  };

  const deleteHistory = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setHistories(prev => prev.filter(h => h.id !== id));
  };

  // ── Build API request ─────────────────────────────────────────────────────────
  // buildRequest is async because cloud providers retrieve their key from the OS
  // keychain via the backend (invoke "get_api_key"). The key is never stored in
  // React state — it is fetched only at call time and used once.

  const mergeConsecutiveRoles = (msgs: { role: string; content: string }[]) => {
    if (msgs.length === 0) return [];
    const merged: { role: string; content: string }[] = [];
    for (const msg of msgs) {
      if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
        merged[merged.length - 1].content += "\n\n" + msg.content;
      } else {
        merged.push({ ...msg });
      }
    }
    return merged;
  };

  const buildRequest = async (messages: { role: string; content: string }[], streaming: boolean) => {
    if (!config) throw new Error("No configuration loaded.");
    const model = selectedModel || "gpt-4o";
    const entry = models.find(m => m.value === model);
    const provType = entry?.type || "cloud";
    const provName = entry?.provider || "openai";

    const normalizedMessages = mergeConsecutiveRoles(messages);

    if (provType === "local" && provName === "lmstudio") {
      const base = (config.lmstudio_url || "http://localhost:1234").replace(/\/+$/, "");
      return { provider: "lmstudio", url: `${base}/v1/chat/completions`, body: JSON.stringify({ model, messages: normalizedMessages, stream: streaming }), headers: [["Content-Type","application/json"]] as string[][] };
    }
    if (provType === "local" && provName === "ollama") {
      const base = (config.ollama_url || "http://localhost:11434").replace(/\/+$/, "");
      return { provider: "ollama", url: `${base}/api/chat`, body: JSON.stringify({ model, messages: normalizedMessages, stream: streaming }), headers: [["Content-Type","application/json"]] as string[][] };
    }

    const prov = selectedCloudProvider || config.cloud_provider || "openai";
    // Check that a key is configured (masked marker "••••••••••••••••" means it's in the keychain)
    const hasKey = !!(config.api_keys?.[prov]);
    if (!hasKey) throw new Error(`No API key configured for ${prov}. Add it in Settings.`);

    // Retrieve the real key from the OS keychain — never stored in JS state
    const key = await invoke<string>("get_api_key", { provider: prov });

    if (prov === "anthropic") {
      const aMessages = normalizedMessages.filter(m => m.role !== "system").map(m => ({ role: m.role as "user"|"assistant", content: m.content }));
      const sys = normalizedMessages.find(m => m.role === "system");
      const body: any = { model, max_tokens: 4096, messages: aMessages };
      if (streaming) body.stream = true;
      if (sys) body.system = sys.content;
      return { provider: "anthropic", url: "https://api.anthropic.com/v1/messages", body: JSON.stringify(body), headers: [["x-api-key",key],["anthropic-version","2023-06-01"],["Content-Type","application/json"]] as string[][] };
    }
    if (prov === "ollama_cloud") {
      return {
        provider: "ollama_cloud",
        url: "https://ollama.com/api/chat",
        body: JSON.stringify({ model, messages: normalizedMessages, stream: streaming }),
        headers: [["Authorization", `Bearer ${key}`], ["Content-Type", "application/json"]] as string[][],
      };
    }

    const URLS: Record<string,string> = {
      openai: "https://api.openai.com/v1/chat/completions",
      deepseek: "https://api.deepseek.com/chat/completions",
      mistral: "https://api.mistral.ai/v1/chat/completions",
      google: "https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions",
      grok: "https://api.x.ai/v1/chat/completions",
      together: "https://api.together.xyz/v1/chat/completions",
      openrouter: "https://openrouter.ai/api/v1/chat/completions",
      nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
    };
    const url = URLS[prov] || URLS.openai;
    if (prov === "openrouter") {
      return { provider: prov, url, body: JSON.stringify({ model, messages: normalizedMessages, max_tokens: 4096, stream: streaming, include_reasoning: true }), headers: [["Authorization",`Bearer ${key}`],["Content-Type","application/json"]] as string[][] };
    }
    return { provider: prov, url, body: JSON.stringify({ model, messages: normalizedMessages, max_tokens: 4096, stream: streaming }), headers: [["Authorization",`Bearer ${key}`],["Content-Type","application/json"]] as string[][] };
  };

  // ── Streaming ─────────────────────────────────────────────────────────────────

  function extractThinkingFromContent(text: string): { thinking: string; content: string; isThinking: boolean } {
    const thinkStart = text.indexOf("<think>");
    if (thinkStart === -1) {
      return { thinking: "", content: text, isThinking: false };
    }
    const thinkEnd = text.indexOf("</think>");
    if (thinkEnd === -1) {
      return { thinking: text.slice(thinkStart + 7), content: text.slice(0, thinkStart), isThinking: true };
    } else {
      return { thinking: text.slice(thinkStart + 7, thinkEnd), content: text.slice(0, thinkStart) + text.slice(thinkEnd + 8), isThinking: false };
    }
  }

  const streamLLM = async (msgId: string, messages: { role: string; content: string }[]) => {
    const req = await buildRequest(messages, true);
    const sid = `chat-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    activeStreamIdRef.current = sid;
    streamTextRef.current = "";
    streamThinkingRef.current = "";
    streamThinkingStartRef.current = null;
    streamThinkingElapsedRef.current = null;

    streamUnlistenRef.current = (await listen<string>(`stream-chunk-${sid}`, (e) => {
      if (activeStreamIdRef.current !== sid) return;
      
      const thinkingDelta = parseStreamThinking(e.payload, req.provider);
      if (thinkingDelta) {
        if (streamThinkingStartRef.current === null) streamThinkingStartRef.current = Date.now();
        streamThinkingRef.current += thinkingDelta;
      }
      
      const delta = parseStreamDelta(e.payload, req.provider);
      if (delta) {
        streamTextRef.current += delta;
      }
      
      const extracted = extractThinkingFromContent(streamTextRef.current);
      const combinedThinkingText = (streamThinkingRef.current + extracted.thinking).trim();
      const hasThinkingText = combinedThinkingText.length > 0;
      
      const isCurrentlyThinking = (hasThinkingText && !delta) || extracted.isThinking;
      
      if (hasThinkingText && streamThinkingStartRef.current === null) {
        streamThinkingStartRef.current = Date.now();
      }
      
      if (hasThinkingText && !isCurrentlyThinking && streamThinkingElapsedRef.current === null) {
        streamThinkingElapsedRef.current = Math.max(0, Date.now() - (streamThinkingStartRef.current ?? Date.now()));
      }
      
      const elapsedMs = streamThinkingElapsedRef.current ?? (streamThinkingStartRef.current !== null ? Date.now() - streamThinkingStartRef.current : 0);
      
      setMsgs(p => p.map(m => m.id === msgId ? {
        ...m,
        body: visibleStreamText(extracted.content),
        thinking: thinkingPreviewEnabled && hasThinkingText
          ? {
              text: combinedThinkingText,
              elapsedMs,
              open: m.thinking?.open ?? (isCurrentlyThinking ? true : false),
              done: !isCurrentlyThinking,
            }
          : m.thinking,
      } : m));
    })) as unknown as () => void;

    try {
      await invoke("curl_post_stream", { url: req.url, body: req.body, headers: req.headers, sessionId: sid });
    } finally {
      activeStreamIdRef.current = null;
      streamUnlistenRef.current?.();
      streamUnlistenRef.current = null;
      
      const extracted = extractThinkingFromContent(streamTextRef.current);
      const combinedThinkingText = (streamThinkingRef.current + extracted.thinking).trim();
      const hasThinkingText = combinedThinkingText.length > 0;
      
      const elapsedMs = streamThinkingElapsedRef.current ?? (streamThinkingStartRef.current !== null ? Math.max(0, Date.now() - streamThinkingStartRef.current) : 0);
      streamThinkingElapsedRef.current = elapsedMs;
      
      const finalBody = visibleStreamText(extracted.content);
      setMsgs(p => p.map(m => m.id === msgId ? {
        ...m,
        streaming: false,
        // If stream finished with no content, surface a hint instead of silent empty bubble
        body: finalBody || "_(No response received. The model may be loading, offline, or returned an empty reply. Check the console for details.)_",
        thinking: thinkingPreviewEnabled && hasThinkingText
          ? { text: combinedThinkingText, elapsedMs, open: m.thinking?.open ?? false, done: true }
          : m.thinking,
      } : m));
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
    
    const extracted = extractThinkingFromContent(streamTextRef.current);
    const combinedThinkingText = (streamThinkingRef.current + extracted.thinking).trim();
    const hasThinkingText = combinedThinkingText.length > 0;
    
    const elapsedMs = streamThinkingElapsedRef.current ?? (streamThinkingStartRef.current !== null ? Math.max(0, Date.now() - streamThinkingStartRef.current) : 0);
    streamThinkingElapsedRef.current = elapsedMs;
    
    setMsgs(p => p.map(m => m.streaming ? {
      ...m,
      streaming: false,
      body: visibleStreamText(extracted.content),
      thinking: hasThinkingText && m.thinking ? { ...m.thinking, text: combinedThinkingText, elapsedMs, done: true } : m.thinking,
    } : m));
  };

  const callLLM = async (messages: { role: string; content: string }[]): Promise<string> => {
    const req = await buildRequest(messages, false);
    const res = await invoke<string>("curl_post", { url: req.url, body: req.body, headers: req.headers });
    const d = JSON.parse(res);
    if (req.provider === "ollama" || req.provider === "ollama_cloud") return d.message?.content || "_(no response)_";
    if (req.provider === "anthropic") return d.content?.[0]?.text || "_(no response)_";
    const message = d.choices?.[0]?.message || {};
    const toolText = message.tool_calls?.length ? `\n${JSON.stringify({ tool_calls: message.tool_calls })}` : "";
    return `${message.content || ""}${toolText}`.trim() || "_(no response)_";
  };

  const addToolLog = (action: AgentAction, status: ToolCallLog["status"], note?: string) => {
    const id = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const log: ToolCallLog = { id, action, status, ts: ts(), note };
    setToolCalls(prev => [log, ...prev].slice(0, 80));
    setMsgs(prev => [...prev, {
      id: `tool-${id}`,
      role: "ai",
      agent: "tool",
      body: formatToolLogBody(log),
      toolLog: log,
      ts: log.ts,
    }]);
    return id;
  };

  const updateToolLog = (id: string, status: ToolCallLog["status"], note?: string) => {
    setToolCalls(prev => prev.map(t => t.id === id ? { ...t, status, note: note ?? t.note } : t));
    setMsgs(prev => prev.map(m => {
      if (m.toolLog?.id !== id) return m;
      const nextLog = { ...m.toolLog, status, note: note ?? m.toolLog.note };
      return { ...m, body: formatToolLogBody(nextLog), toolLog: nextLog };
    }));
  };

  const commandMatchesAgent = (command: string, agentType?: string) => {
    if (!agentType) return false;
    return command.toLowerCase().split(/\s+/)[0] === agentType.toLowerCase();
  };

  /**
   * Augment a prompt going to a terminal with any matching installed skills.
   *
   * Combines two sources:
   *   1. Skills matched from the original user message (currentTaskSkillsRef) — avoids
   *      missing skills when the LLM rephrases the task in ways that drop trigger keywords.
   *   2. Skills re-matched from the agent-specific prompt — catches any additional context.
   *
   * If skill files were already written to the workspace (currentTaskSkillFilePathsRef),
   * includes file references so CLI agents can read the full skill content from disk.
   */
  const injectSkillsIntoPrompt = (promptText: string): string => {
    const allSkills = installedSkillsRef.current;
    if (!allSkills.length) return promptText;

    // Union: task-level skills (from original user msg) + prompt-matched skills
    const taskSkills = currentTaskSkillsRef.current;
    const promptMatched = matchSkills(promptText, allSkills);
    const combined = Array.from(
      new Map([...taskSkills, ...promptMatched].map(s => [s.id, s])).values()
    );
    if (!combined.length) return promptText;

    const notice = skillNotice(combined);
    const block = buildSkillBlock(combined);
    const fileRef = buildSkillFileRef(combined, currentTaskSkillFilePathsRef.current);
    return promptText + notice + block + fileRef;
  };

  const sendToSession = (session: Session, promptText: string, logId: string) => {
    usedPromptSessionIdsRef.current.add(session.sessionId);
    // Inject relevant skills into every prompt sent to a terminal agent
    const enrichedPrompt = injectSkillsIntoPrompt(promptText);

    // Skills are injected inline into the prompt — logged once at detection time in send().

    if (session.status === "exited") {
      const newSessId = onRestartSessionRef.current?.(session.id);
      if (!newSessId) {
        updateToolLog(logId, "failed", "Could not restart exited session.");
        return;
      }
      updateToolLog(logId, "queued", `Restarting ${session.label}…`);
      // Poll for "running" status, retry up to 3 × 4s = 12s
      const waitAndSend = (attempt: number) => {
        setTimeout(() => {
          const current = sessionsRef.current.find(s => s.id === session.id);
          if (!current) { updateToolLog(logId, "failed", `${session.label} session gone.`); return; }
          if (current.status === "running") {
            onSendPtyCommandRef.current?.(current.sessionId, enrichedPrompt);
            updateToolLog(logId, "done", `Sent to restarted ${session.label}.`);
          } else if (current.status === "booting" && attempt < 3) {
            updateToolLog(logId, "queued", `Still waiting for ${session.label} (${attempt + 1}/3)…`);
            waitAndSend(attempt + 1);
          } else {
            // Boot took too long — send anyway
            onSendPtyCommandRef.current?.(current.sessionId, enrichedPrompt);
            updateToolLog(logId, "done", `Sent to ${session.label} (forced after boot timeout).`);
          }
        }, 4000);
      };
      waitAndSend(0);
      return;
    }
    if (session.status === "booting") {
      updateToolLog(logId, "queued", `Waiting for ${session.label} to boot…`);
      const waitAndSend = (attempt: number) => {
        setTimeout(() => {
          const current = sessionsRef.current.find(s => s.id === session.id);
          if (!current) { updateToolLog(logId, "failed", `${session.label} session gone.`); return; }
          if (current.status === "running") {
            onSendPtyCommandRef.current?.(current.sessionId, enrichedPrompt);
            updateToolLog(logId, "done", `Sent to ${session.label}.`);
          } else if (current.status === "booting" && attempt < 3) {
            waitAndSend(attempt + 1);
          } else {
            onSendPtyCommandRef.current?.(current.sessionId, enrichedPrompt);
            updateToolLog(logId, "done", `Sent to ${session.label} (forced after boot timeout).`);
          }
        }, 4000);
      };
      waitAndSend(0);
      return;
    }
    onSendPtyCommandRef.current?.(session.sessionId, enrichedPrompt);
    updateToolLog(logId, "done", `Sent to ${session.label}.`);
  };

  const autoDispatchActions = (actions: AgentAction[]) => {
    pendingDirectActionsCountRef.current = 0;
    const usedSessionIds = new Set<string>();
    const monitorSessionIds: string[] = [];

    for (const action of actions) {
      const logId = addToolLog(action, "queued");

      if (action.type === "ask_user") {
        updateToolLog(logId, "waiting", action.question || action.reason || "Waiting for user input.");
        setMsgs(p => [...p, {
          id: `q${Date.now()}`,
          role: "ai",
          agent: "system",
          body: `**Need more info:** ${action.question || action.reason || "I need one more detail before continuing."}`,
          ts: ts(),
        }]);
        continue;
      }

      if (action.type === "browser_open") {
        if (!onOpenBrowserRef.current) {
          updateToolLog(logId, "failed", "Browser bridge is not available.");
          continue;
        }
        pendingDirectActionsCountRef.current++;
        onOpenBrowserRef.current({
          id: logId,
          url: action.url,
          label: action.label,
          device: action.device,
          mode: action.mode === "web" ? "web" : action.mode === "app" ? "app" : undefined,
        });
        updateToolLog(logId, "done", action.url ? `Opened ${action.url}.` : "Opened integrated browser.");
        decrementPendingDirectActions();
        continue;
      }

      if (action.type === "broadcast" && action.prompt) {
        const targets = sessionsRef.current.filter(s => !usedSessionIds.has(s.sessionId));
        if (!targets.length) {
          updateToolLog(logId, "failed", "No active sessions available.");
          continue;
        }
        updateToolLog(logId, "running", `Dispatching to ${targets.length} active agent${targets.length > 1 ? "s" : ""}.`);
        targets.forEach(session => {
          usedSessionIds.add(session.sessionId);
          monitorSessionIds.push(session.sessionId);
          sendToSession(session, action.prompt || "", logId);
        });
        updateToolLog(logId, "done", `Sent to ${targets.length} active agent${targets.length > 1 ? "s" : ""}.`);
        continue;
      }

      if (action.type === "mode") {
        const target = sessionsRef.current.find(s => s.label.toLowerCase() === action.label.toLowerCase());
        const nextCommand = action.agentType || action.mode;
        if (!target || !nextCommand || !onChangeSessionAgentRef.current) {
          updateToolLog(logId, "failed", "Could not switch agent mode.");
          continue;
        }
        const newSessionId = onChangeSessionAgentRef.current(target.id, action.label, nextCommand, true);
        updateToolLog(logId, "done", `Switched ${target.label} to ${nextCommand}.`);
        if (action.prompt && newSessionId) {
          monitorSessionIds.push(newSessionId);
          setTimeout(() => onSendPtyCommandRef.current?.(newSessionId, injectSkillsIntoPrompt(action.prompt || "")), 4000);
        }
        continue;
      }

      if (action.type === "request" && action.agentType) {
        const count = action.count || 1;
        const request: PendingAgentRequest = {
          id: logId,
          label: action.label,
          agentType: action.agentType,
          count,
          prompt: action.prompt,
          reason: action.reason,
          existingSessionIds: sessionsRef.current.map(s => s.sessionId),
          fulfilledSessionIds: [],
        };
        setPendingAgentRequests(prev => [...prev, request]);
        updateToolLog(logId, "waiting", `Waiting for ${count} ${action.agentType} agent${count > 1 ? "s" : ""}.`);
        setMsgs(p => [...p, {
          id: `req${Date.now()}`,
          role: "ai",
          agent: "system",
          body: `Potřebuju ${count} další ${action.agentType} agent${count > 1 ? "y" : "a"} pro: ${action.reason || action.label}. Jakmile ho přidáš přes +, automaticky ho detekuju a pošlu mu úkol.`,
          ts: ts(),
        }]);
        continue;
      }

      if ((action.type === "spawn" || action.type === "send") && action.prompt) {
        const promptText = action.prompt;
        let target = sessionsRef.current.find(s =>
          !usedSessionIds.has(s.sessionId) &&
          s.label.toLowerCase() === action.label.toLowerCase()
        );

        if (!target && action.type === "spawn") {
          target = sessionsRef.current.find(s =>
            !usedSessionIds.has(s.sessionId) &&
            commandMatchesAgent(s.command, action.agentType)
          );
        }

        if (!target && action.type === "send") {
          target = sessionsRef.current.find(s => !usedSessionIds.has(s.sessionId));
        }

        if (target) {
          usedSessionIds.add(target.sessionId);
          monitorSessionIds.push(target.sessionId);
          updateToolLog(logId, "running", `Dispatching to ${target.label}.`);
          sendToSession(target, promptText, logId);
        } else if (action.type === "spawn" && action.agentType) {
          const spawned = onAddSessionRef.current?.(action.label, action.agentType);
          if (spawned && spawned.sessionId) {
            usedSessionIds.add(spawned.sessionId);
            monitorSessionIds.push(spawned.sessionId);
            updateToolLog(logId, "running", `Spawned ${spawned.label}.`);
            setTimeout(() => sendToSession(spawned, promptText, logId), 4000);
          } else {
            updateToolLog(logId, "failed", "No session was created.");
          }
        } else {
          updateToolLog(logId, "failed", "No matching session found.");
        }
        continue;
      }

      if (action.type === "kill") {
        const target = sessionsRef.current.find(s => s.label.toLowerCase() === action.label.toLowerCase());
        if (target) {
          pendingDirectActionsCountRef.current++;
          onCloseSessionRef.current?.(target.id);
          updateToolLog(logId, "done", `Closed ${target.label}.`);
          decrementPendingDirectActions();
        } else {
          updateToolLog(logId, "failed", "No matching session found.");
        }
      }

      if (action.type === "read_file" && action.filePath) {
        // Resolve relative paths against the workspace directory
        const rawPath = action.filePath;
        const isAbsolute = /^([A-Za-z]:[\\\/]|\/|\\\\)/.test(rawPath);
        const resolvedPath = (!isAbsolute && workspaceDir)
          ? `${workspaceDir}\\${rawPath.replace(/\//g, "\\")}` : rawPath;

        pendingDirectActionsCountRef.current++;

        const executeReadFile = () => {
          updateToolLog(logId, "running", `Reading ${rawPath}`);
          invoke<string>("read_file_content", { filePath: resolvedPath })
            .then(content => {
              const lines = content.split("\n").length;
              const preview = content.slice(0, 3000);
              updateToolLog(logId, "done", `${lines} lines`);
              setMsgs(p => [...p, {
                id: `rf-${Date.now()}`,
                role: "ai" as const,
                agent: "system" as const,
                body: `**File:** \`${rawPath}\`\n\`\`\`\n${preview}${content.length > 3000 ? "\n…[clipped]" : ""}\n\`\`\``,
                ts: ts(),
              }]);
            })
            .catch(err => {
              updateToolLog(logId, "failed", String(err));
            })
            .finally(() => {
              decrementPendingDirectActions();
            });
        };

        if (chatToolMode === "bypass") {
          executeReadFile();
        } else {
          // Ask mode: show approval message
          const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2,5)}`;
          pendingApprovalsRef.current.set(approvalId, executeReadFile);
          updateToolLog(logId, "waiting", `Awaiting approval`);
          setMsgs(p => [...p, {
            id: approvalId,
            role: "ai" as const,
            agent: "system" as const,
            body: `🔒 **Permission Request:** AI wants to read \`${rawPath}\`.\n\nAllow this action?`,
            pendingApproval: { approvalId, logId, denyLabel: "Deny read_file" },
            ts: ts(),
          } as any]);
        }
      }

      if (action.type === "exec_cmd" && action.cmdString) {
        pendingDirectActionsCountRef.current++;

        const executeCmd = () => {
          updateToolLog(logId, "running", action.cmdString!);
          invoke<string>("run_command_in_dir", { cmd: action.cmdString, dir: workspaceDir || "." })
            .then(output => {
              const preview = output.trim().slice(0, 2000);
              updateToolLog(logId, "done", preview.split("\n").slice(0, 2).join(" "));
              setMsgs(p => [...p, {
                id: `ec-${Date.now()}`,
                role: "ai" as const,
                agent: "system" as const,
                body: `**$** \`${action.cmdString}\`\n\`\`\`\n${preview}${output.length > 2000 ? "\n…[clipped]" : ""}\n\`\`\``,
                ts: ts(),
              }]);
            })
            .catch(err => {
              updateToolLog(logId, "failed", String(err));
              setMsgs(p => [...p, {
                id: `ec-err-${Date.now()}`,
                role: "ai" as const,
                agent: "system" as const,
                body: `**$** \`${action.cmdString}\`\n\`\`\`\n${String(err)}\n\`\`\``,
                ts: ts(),
              }]);
            })
            .finally(() => {
              decrementPendingDirectActions();
            });
        };

        if (chatToolMode === "bypass") {
          executeCmd();
        } else {
          const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2,5)}`;
          pendingApprovalsRef.current.set(approvalId, executeCmd);
          updateToolLog(logId, "waiting", `Awaiting approval`);
          setMsgs(p => [...p, {
            id: approvalId,
            role: "ai" as const,
            agent: "system" as const,
            body: `🔒 **Permission Request:** AI wants to run \`${action.cmdString}\`.\n\nAllow this command?`,
            pendingApproval: { approvalId, logId, denyLabel: "Deny exec_cmd" },
            ts: ts(),
          } as any]);
        }
      }
    }
    if (monitorSessionIds.length) {
      setWorkMonitor({
        id: `wm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        startedAt: Date.now(),
        actions: monitorSessionIds.length,
        sessionIds: monitorSessionIds,
      });
    }
  };

  const answerAgentQuestion = (question: AgentQuestion, answer: string) => {
    const text = answer.trim();
    if (!text) return;
    const session = sessionsRef.current.find(s => s.sessionId === question.sessionId);
    if (!session) {
      notifyError("That agent session is no longer available.");
      return;
    }
    const action: AgentAction = { type: "send", label: session.label, prompt: text };
    const logId = addToolLog(action, "running", `Answering ${session.label}.`);
    sendToSession(session, text, logId);
    setAgentQuestions(prev => prev.map(q => q.id === question.id ? { ...q, answered: true } : q));
    setMsgs(prev => [...prev, {
      id: `ans-${Date.now()}`,
      role: "user",
      body: `@${session.label}: ${text}`,
      ts: ts(),
    }]);
    setInput("");
  };

  // ── Send ──────────────────────────────────────────────────────────────────────

  const nextPlanFilePath = async (fileName: string): Promise<{ path: string; name: string }> => {
    const baseDir = workspaceDir || "";
    if (!baseDir) return { path: fileName, name: fileName };
    const dot = fileName.lastIndexOf(".");
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : ".md";
    for (let i = 0; i < 20; i++) {
      const candidateName = i === 0 ? fileName : `${stem}-${i + 1}${ext}`;
      const candidatePath = joinWorkspacePath(baseDir, candidateName);
      try {
        await invoke<string>("read_file_content", { filePath: candidatePath });
      } catch {
        return { path: candidatePath, name: candidateName };
      }
    }
    const fallbackName = `${stem}-${Date.now()}${ext}`;
    return { path: joinWorkspacePath(baseDir, fallbackName), name: fallbackName };
  };

  const createImplementationPlanFile = async (plan: PendingPlan) => {
    if (!workspaceDir) {
      setMsgs(prev => [...prev, {
        id: `plan-error-${Date.now()}`,
        role: "ai",
        agent: "system",
        body: "Nemám aktivní workspace directory, takže nemůžu vytvořit markdown soubor.",
        ts: ts(),
      }]);
      return;
    }

    const target = await nextPlanFilePath(plan.fileName);
    const content = `# Implementation Plan\n\n${plan.planText.trim()}\n`;
    const action: AgentAction = { type: "file_create", label: target.name, prompt: "Create implementation plan markdown file" };
    const logId = addToolLog(action, "running", `Creating ${target.path}.`);
    try {
      await invoke("create_file", { filePath: target.path, content });
      updateToolLog(logId, "done", `Created ${target.path}.`);
      setPendingPlan(null);
      setMsgs(prev => [...prev, {
        id: `plan-created-${Date.now()}`,
        role: "ai",
        agent: "orchestrator",
        body: `Hotovo, vytvořil jsem \`${target.name}\` v kořeni workspace.`,
        ts: ts(),
      }]);
    } catch (err) {
      updateToolLog(logId, "failed", String(err));
      setMsgs(prev => [...prev, {
        id: `plan-create-failed-${Date.now()}`,
        role: "ai",
        agent: "system",
        body: `Soubor se nepovedlo vytvořit: ${String(err)}`,
        ts: ts(),
      }]);
    }
  };

  const runPlanMode = async (userMsg: Msg) => {
    const history = msgs.filter(m => (m.role === "user" || m.role === "ai") && !m.streaming).slice(-24).map(m => ({
      role: (m.role === "user" || m.agent !== "orchestrator") ? "user" as const : "assistant" as const,
      content: messageForModel(m),
    }));
    const llmMsgs = [
      { role: "system", content: buildPlanPrompt(contextWindowRef.current, changedFilesRef.current, installedSkillsRef.current) },
      ...history,
      { role: "user", content: messageForModel(userMsg) },
    ];
    const aiMsgId = `plan-${Date.now()}`;
    setMsgs(p => [...p, {
      id: aiMsgId,
      role: "ai",
      agent: "orchestrator",
      body: "",
      streaming: streamingEnabled,
      ts: ts(),
    }]);

    let planText = "";
    if (streamingEnabled) {
      await streamLLM(aiMsgId, llmMsgs);
      planText = stripAgentTags(streamTextRef.current).trim();
    } else {
      planText = stripAgentTags(await callLLM(llmMsgs)).trim();
    }
    const prompt = "\n\nChceš z toho vytvořit `implementation.md` soubor? Napiš `ano` nebo `ne`.";
    setPendingPlan({ planText, requestedAt: Date.now(), fileName: "implementation.md" });
    setMsgs(p => p.map(m => m.id === aiMsgId ? {
      ...m,
      streaming: false,
      body: `${planText}${prompt}`,
    } : m));
  };

  const send = async (e?: React.FormEvent, overrideText?: string, overrideAttachments?: ChatAttachment[]) => {
    if (e) e.preventDefault();
    const text = (overrideText ?? input).trim();
    const mentionedFiles = parseFileMentions(text, mentionFilesRef.current);
    const attachments = await hydrateFileMentionAttachments([...(overrideAttachments || composerAttachments), ...mentionedFiles]);
    if ((!text && !attachments.length) || isProcessing) return;
    const userMsg: Msg = {
      id: `u${Date.now()}`,
      role:"user",
      body: text || "Attached file/image",
      attachments: attachments.length ? attachments : undefined,
      ts: ts(),
    };
    setMsgs(p => [...p, userMsg]);
    if (!overrideText) {
      setInput("");
      setComposerAttachments([]);
    }
    setIsProcessing(true);
    pendingDirectActionsCountRef.current = 0;
    let aiMsgId = "";
    try {
      if (pendingPlan && !overrideText && !attachments.length && (isAffirmative(text) || isNegative(text))) {
        if (isAffirmative(text)) {
          await createImplementationPlanFile(pendingPlan);
        } else {
          setPendingPlan(null);
          setMsgs(p => [...p, {
            id: `plan-skip-${Date.now()}`,
            role: "ai",
            agent: "orchestrator",
            body: "Jasně, markdown soubor z plánu vytvářet nebudu.",
            ts: ts(),
          }]);
        }
        return;
      }

      if (chatMode === "plan" && !overrideText) {
        setPendingPlan(null);
        await runPlanMode(userMsg);
        return;
      }

      // ── Skill detection, file writing & injection ─────────────────────────
      const matchedSkills = matchSkills(text, installedSkillsRef.current);
      const skillBlock = buildSkillBlock(matchedSkills);

      // Store matched skills in refs so sendToSession can access them without
      // re-matching from LLM-rephrased prompts that may not contain trigger keywords.
      currentTaskSkillsRef.current = matchedSkills;
      currentTaskSkillFilePathsRef.current = [];

      // Show skill detection log, then update it to file_written after async write
      if (matchedSkills.length > 0) {
        const detectMsgId = `skill-detect-${Date.now()}`;
        const detectionLog: SkillLog = {
          skills: matchedSkills.map(s => ({ name: s.name, slug: s.slug })),
          agentLabel: "chat",
          status: "detected",
        };
        setMsgs(p => [...p, {
          id: detectMsgId,
          role: "ai",
          agent: "skill",
          body: "",
          skillLog: detectionLog,
          ts: ts(),
        }]);

        // Write skill files to workspace (best-effort async — updates log when done)
        if (workspaceDir) {
          (async () => {
            const written: string[] = [];
            for (const skill of matchedSkills) {
              try {
                const path = await invoke<string>("write_skill_to_workspace", {
                  workspaceDir,
                  slug: skill.slug,
                  content: `# Skill: ${skill.name}\n\n${skill.skill_md}`,
                });
                written.push(path);
              } catch {}
            }
            if (written.length > 0) {
              currentTaskSkillFilePathsRef.current = written;
              // Update the detection log to show file_written status
              setMsgs(p => p.map(msg => msg.id === detectMsgId ? {
                ...msg,
                skillLog: { ...detectionLog, status: "file_written" as const, filePaths: written },
              } : msg));
            }
          })();
        }
      }

      const sysPrompt = buildOrchestratorPrompt(
        sessionsRef.current,
        terminalOutputsRef.current,
        terminalTranscriptsRef.current,
        toolCallsRef.current,
        agentQuestionsRef.current,
        contextWindowRef.current,
        installedSkillsRef.current,
      ) + skillBlock; // skills appended to system prompt
      const history = msgs.filter(m => (m.role === "user" || m.role === "ai") && !m.streaming).slice(-40).map(m => {
        let content = messageForModel(m);
        if (m.role === "ai" && m.actions?.length) {
          content += "\n\n" + m.actions.map(a =>
            a.type === "spawn" ? `[Spawned: ${a.label} via ${a.agentType}]`
            : a.type === "send" ? `[Sent to: ${a.label}]`
            : a.type === "broadcast" ? `[Broadcast to agents: ${a.label}]`
            : a.type === "request" ? `[Requested: ${a.count || 1} ${a.agentType} agent(s)]`
            : a.type === "mode" ? `[Changed agent mode: ${a.label} -> ${a.agentType || a.mode}]`
            : a.type === "ask_user" ? `[Asked user: ${a.question || a.reason}]`
            : a.type === "browser_open" ? `[Opened browser: ${a.url || a.label}]`
            : a.type === "file_create" ? `[Created file: ${a.label}]`
            : `[Killed: ${a.label}]`
          ).join(", ");
        }
        return { role: (m.role === "user" || m.agent !== "orchestrator") ? "user" as const : "assistant" as const, content };
      });
      const llmMsgs = [{ role:"system", content: sysPrompt }, ...history, { role:"user", content: messageForModel(userMsg) }];
      aiMsgId = `a${Date.now()}`;

      if (streamingEnabled) {
        setMsgs(p => [...p, {
          id: aiMsgId,
          role:"ai",
          agent:"orchestrator",
          body:"",
          streaming:true,
          ts: ts(),
        }]);
        await streamLLM(aiMsgId, llmMsgs);
        const finalText = streamTextRef.current;
        const actions = parseAgentActions(finalText);
        const visible = stripAgentTags(finalText);
        setMsgs(p => p.map(m => m.id === aiMsgId ? { ...m, streaming:false, body: visible, actions: actions.length ? actions : undefined } : m));
        if (actions.length) {
          autoDispatchActions(actions);
        } else if (detectsAgentIntent(finalText)) {
          // Model described spawning/sending but forgot the tool call format
          setMsgs(p => [...p, {
            id: `hint-${Date.now()}`,
            role: "ai",
            agent: "system",
            body: "⚠️ The model described an agent action in text but did not output a `<tool_call>`. No agents were spawned. Try re-sending — the model was reminded to always include tool calls.",
            ts: ts(),
          }]);
        }
      } else {
        const resp = await callLLM(llmMsgs);
        const actions = parseAgentActions(resp);
        const visible = stripAgentTags(resp);
        setMsgs(p => [...p, { id: aiMsgId, role:"ai", agent:"orchestrator", body: visible, actions: actions.length ? actions : undefined, ts: ts() }]);
        if (actions.length) {
          autoDispatchActions(actions);
        } else if (detectsAgentIntent(resp)) {
          setMsgs(p => [...p, {
            id: `hint-${Date.now()}`,
            role: "ai",
            agent: "system",
            body: "⚠️ The model described an agent action in text but did not output a `<tool_call>`. No agents were spawned. Try re-sending.",
            ts: ts(),
          }]);
        }
      }
    } catch (err: any) {
      const detail = err?.message || String(err || "Failed to get AI response.");
      const modelHint = selectedModelRef.current ? `\n\nModel: \`${selectedModelRef.current}\`` : "";
      setMsgs(p => [
        ...p.filter(m => m.id !== aiMsgId),
        {
          id:`e${Date.now()}`,
          role:"ai",
          agent:"system",
          body:`**Error:** Failed to get AI response.\n\n${detail}${modelHint}`,
          ts: ts(),
        }
      ]);
    } finally {
      setIsProcessing(false);
    }
  };

  const insertMention = (file: MentionFile) => {
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? input.length;
    const before = input.slice(0, cursor);
    const after = input.slice(cursor);
    const replaced = before.replace(/@([\w.\-]*)$/, `@"${file.name}" `);
    setInput(replaced + after);
    setMentionSuggestions([]);
    setMentionQuery(null);
    setMentionIndex(0);
    setTimeout(() => { ta?.focus(); const pos = replaced.length; ta?.setSelectionRange(pos, pos); }, 0);
  };

  const handleInputChange = async (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    const cursor = e.target.selectionStart ?? val.length;
    const beforeCursor = val.slice(0, cursor);
    const match = beforeCursor.match(/@([\w.\-]*)$/);
    if (!match) {
      setMentionQuery(null);
      setMentionSuggestions([]);
      return;
    }
    const q = match[1].toLowerCase();
    setMentionQuery(q);
    setMentionIndex(0);

    // Ensure file list is loaded — load on-demand if ref is empty
    if (mentionFilesRef.current.length === 0 && workspaceDir) {
      try {
        interface FE { path: string; name: string; is_dir: boolean; children?: FE[] }
        const entries = await invoke<FE[]>("list_files", { dirPath: workspaceDir });
        const flat: MentionFile[] = [];
        const recurse = (list: FE[]) => {
          for (const e of list) {
            if (e.is_dir) { if (e.children) recurse(e.children); }
            else flat.push({ path: e.path, name: e.name });
          }
        };
        recurse(entries);
        mentionFilesRef.current = flat;
      } catch {}
    }

    const sugg = mentionFilesRef.current
      .filter(f => !q || f.name.toLowerCase().includes(q))
      .slice(0, 10);
    setMentionSuggestions(sugg);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionSuggestions.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIndex(i => Math.min(i + 1, mentionSuggestions.length - 1)); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Tab" || (e.key === "Enter" && mentionQuery !== null)) {
        e.preventDefault();
        insertMention(mentionSuggestions[mentionIndex]);
        return;
      }
      if (e.key === "Escape") { setMentionSuggestions([]); setMentionQuery(null); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  useEffect(() => {
    if (!externalPrompt || handledExternalPromptRef.current === externalPrompt.id) return;
    handledExternalPromptRef.current = externalPrompt.id;
    if (isProcessing) {
      setInput(externalPrompt.text);
      setComposerAttachments(externalPrompt.attachments || []);
      notifyError("Chat is busy. I placed the browser feedback in the composer.");
      return;
    }
    void send(undefined, externalPrompt.text, externalPrompt.attachments);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalPrompt?.id]);

  // ─── Render ───────────────────────────────────────────────────────────────────

  const renderAttachments = (attachments?: ChatAttachment[]) => {
    if (!attachments?.length) return null;
    return (
      <div className="chat-attachments">
        {attachments.map(att => (
          <div key={att.id} className={`chat-attachment att-${att.type}`}>
            {(att.type === "image" || att.type === "browser-selection") && att.url ? (
              <button type="button" className="chat-attachment-image-btn" onClick={() => setImagePreview(att)} title="Open image preview">
                <img src={att.url} alt={att.name} className="chat-attachment-image" />
              </button>
            ) : (
              <i className="bx bx-file" />
            )}
            <div className="chat-attachment-meta">
              <span>{att.name}</span>
              {(att.path || att.detail) && <small>{att.path || att.detail}</small>}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderDiffLog = (log: DiffLog) => (
    <div className="chat-diff-message">
      <div className="chat-diff-message-head">
        <span className="chat-diff-kicker"><i className="bx bx-git-compare" /> Diff view</span>
        <span className="chat-diff-count">{log.total} file{log.total !== 1 ? "s" : ""}</span>
      </div>
      <div className="chat-diff-files">
        {log.files.map(file => (
          <button
            key={`${log.id}-${file.path}`}
            type="button"
            className="chat-diff-file"
            onClick={() => onOpenDiffFile?.(file.path, file.name)}
            title={file.path}
          >
            <span className={`chat-diff-status ${file.status}`}>{file.status === "new" ? "NEW" : "MOD"}</span>
            <span className="chat-diff-name">{file.name}</span>
            <span className="chat-diff-path">{file.path}</span>
          </button>
        ))}
      </div>
    </div>
  );

  const renderToolStrip = (log: ToolCallLog, ts_val?: string) => {
    const ACTION_ICONS: Record<string, string> = {
      spawn: "bx-plus-circle", send: "bx-send", broadcast: "bx-rss",
      kill: "bx-x-circle", request: "bx-user-plus", mode: "bx-transfer",
      ask_user: "bx-comment-dots", browser_open: "bx-world", file_create: "bx-file-plus",
    };
    const icon = ACTION_ICONS[log.action.type] || "bx-cog";
    const target = toolLogTarget(log);
    const note = toolLogNote(log);
    return (
      <div className={`tool-strip tool-strip-${log.status}`}>
        <i className={`bx ${icon} tool-strip-icon`} />
        <span className="tool-strip-action">{log.action.type.replace("_", ".")}</span>
        <span className="tool-strip-sep">→</span>
        <span className="tool-strip-target">{target}</span>
        {note && <span className="tool-strip-note">{note}</span>}
        <span className={`tool-strip-dot dot-${log.status}`} title={log.status} />
        {ts_val && <span className="tool-strip-ts">{ts_val}</span>}
      </div>
    );
  };

  // Keep old renderToolLog for inline use (diff, etc.) but now unused in msgs
  const renderToolLog = renderToolStrip;

  const toggleThinking = (msgId: string) => {
    setMsgs(prev => prev.map(msg => msg.id === msgId && msg.thinking
      ? { ...msg, thinking: { ...msg.thinking, open: !msg.thinking.open } }
      : msg
    ));
  };

  return (
    <div ref={chatPanelRef} className={`chat-panel ${embedded ? "embedded" : ""}`}>
      {imagePreview?.url && (
        <div className="chat-image-lightbox" role="dialog" aria-modal="true" onClick={() => setImagePreview(null)}>
          <div className="chat-image-lightbox-inner" onClick={event => event.stopPropagation()}>
            <button type="button" className="chat-image-lightbox-close" onClick={() => setImagePreview(null)} title="Close image preview">
              <i className="bx bx-x" />
            </button>
            <img src={imagePreview.url} alt={imagePreview.name} />
            <div className="chat-image-lightbox-caption">{imagePreview.name}</div>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div className="chat-panel-header">
        <div className="chat-header-left">
          <span className="chat-header-logo-wrap">
            <img src="/logo.png" className="chat-header-logo" alt="" />
            <span className={`chat-header-dot ${models.length > 0 ? "online" : "offline"}`} />
          </span>
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
                      setTermCustomOpen(false);
                    }}
                  >
                    <i className={`bx ${ag.icon}`} />
                    <span>{ag.label}</span>
                  </button>
                ))}
                {/* Custom option */}
                <button
                  type="button"
                  className={`chat-dropdown-item ${termCustomOpen ? "active" : ""}`}
                  onClick={() => { setTermCustomOpen(o => !o); setTermCustomLabel(""); setTermCustomCommand(""); }}
                >
                  <i className="bx bx-code-curly" />
                  <span>Custom…</span>
                </button>
                {termCustomOpen && (
                  <div className="chat-term-custom-fields" onClick={e => e.stopPropagation()}>
                    <input
                      className="chat-term-custom-input"
                      type="text"
                      placeholder="Label (optional)"
                      value={termCustomLabel}
                      onChange={e => setTermCustomLabel(e.target.value)}
                    />
                    <input
                      className="chat-term-custom-input"
                      type="text"
                      placeholder="Launch command (e.g. aider)"
                      value={termCustomCommand}
                      autoFocus
                      onChange={e => setTermCustomCommand(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && termCustomCommand.trim()) {
                          onAddSessionRef.current?.(termCustomLabel.trim() || termCustomCommand.trim(), termCustomCommand.trim());
                          setTermPickerOpen(false);
                          setTermCustomOpen(false);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="chat-term-custom-launch"
                      disabled={!termCustomCommand.trim()}
                      onClick={() => {
                        if (!termCustomCommand.trim()) return;
                        onAddSessionRef.current?.(termCustomLabel.trim() || termCustomCommand.trim(), termCustomCommand.trim());
                        setTermPickerOpen(false);
                        setTermCustomOpen(false);
                      }}
                    >
                      <i className="bx bx-play" /> Launch
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* History */}
          <div className="chat-header-dropdown-wrap" ref={historyRef}>
            <button
              type="button"
              className={`chat-hdr-btn ${historyOpen ? "active" : ""}`}
              title="Chat history"
              onClick={() => {
                setHistoryOpen(o => {
                  const next = !o;
                  if (next) {
                    const currentCount = histories.length;
                    setLastSeenHistoryCount(currentCount);
                    try {
                      localStorage.setItem("integraded_chat_default_last_seen_history_count", String(currentCount));
                    } catch {}
                  }
                  return next;
                });
                setTermPickerOpen(false);
              }}
            >
              <i className="bx bx-history" />
              {historyHydrated && histories.length > lastSeenHistoryCount && (
                <span className="chat-hdr-badge">
                  {histories.length - lastSeenHistoryCount}
                </span>
              )}
            </button>
            {historyOpen && (
              <div className="chat-dropdown chat-history-panel">
                <div className="chat-history-header">
                  <span className="chat-dropdown-label">History</span>
                  <button type="button" className="chat-history-new-btn" onClick={saveAndNewChat}>
                    <i className="bx bx-plus" /> New chat
                  </button>
                </div>
                {msgs.length === 0 && histories.length === 0 ? (
                  <div className="chat-history-empty">No saved chats</div>
                ) : (
                  <div className="chat-history-list">
                    {/* Current active session — always shown at top if it has messages */}
                    {msgs.length > 0 && (() => {
                      const cleanMsgs = normalizeMessages(msgs);
                      const name = cleanMsgs.find(m => m.role === "user")?.body.slice(0, 60) || "Active chat";
                      return (
                        <div key="__current__" className="chat-history-item chat-history-item-active">
                          <div className="chat-history-item-name">
                            <span className="chat-history-active-dot" />
                            {name}
                          </div>
                          <div className="chat-history-item-meta">
                            <span>{relativeTime(currentChatMeta.createdAt)}</span>
                            <span className="chat-history-item-count">{cleanMsgs.length} msgs</span>
                          </div>
                        </div>
                      );
                    })()}
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
      {false && sessionsProp.length > 0 && (
        <div className="chat-sessions-strip">
          {sessionsProp.slice(0, 4).map(s => (
            <span key={s.sessionId} className={`chat-sess-chip sess-${s.status || "unknown"}`} title={`${s.command} — ${s.sessionId}\n${(terminalOutputsProp[s.sessionId] || "").slice(-220)}`}>
              <i className="bx bx-terminal" />{s.label}
              <span className="chat-sess-status">{s.status || "live"}</span>
            </span>
          ))}
          {sessionsProp.length > 4 && (
            <span className="chat-sess-chip chat-sess-more">+{sessionsProp.length - 4}</span>
          )}
        </div>
      )}

      {/* ── Messages ── */}
      {agentQuestions.some(q => !q.answered) && (
        <div className="chat-question-stack">
          {agentQuestions.filter(q => !q.answered).slice(0, 3).map(q => (
            <div key={q.id} className="chat-question-card">
              <div className="chat-question-main">
                <span className="chat-question-label">{q.label}</span>
                <span className="chat-question-text">{q.question}</span>
              </div>
              <div className="chat-question-actions">
                <button
                  type="button"
                  className="chat-question-btn"
                  disabled={!input.trim()}
                  onClick={() => answerAgentQuestion(q, input)}
                  title="Send typed answer to this CLI agent"
                >
                  <i className="bx bx-send" />
                </button>
                <button
                  type="button"
                  className="chat-question-btn"
                  onClick={() => setAgentQuestions(prev => prev.map(x => x.id === q.id ? { ...x, answered: true } : x))}
                  title="Dismiss"
                >
                  <i className="bx bx-check" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {false && toolCalls.length > 0 && (
        <div className="chat-tool-timeline" aria-label="Tool call history">
          <div className="chat-tool-timeline-head">
            <span><i className="bx bx-list-check" /> Tool calls</span>
            <span>{toolCalls.length}</span>
          </div>
          <div className="chat-tool-timeline-list">
            {toolCalls.slice(0, 6).map(t => {
              const note = t.note || t.action.url || t.action.reason || t.action.prompt || t.action.question || "Queued";
              return (
                <div key={t.id} className={`chat-tool-inline tool-${t.status}`}>
                  <span className={`chat-tool-status tool-status-${t.status}`}>{t.status}</span>
                  <span className="chat-tool-type">{t.action.type}</span>
                  <span className="chat-tool-target">{t.action.label}</span>
                  <span className="chat-tool-note-inline">{note}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="chat-messages-shell">
      <div className="chat-messages" ref={messagesRef} onScroll={updateChatAtBottom}>
        {msgs.length === 0 ? (
          <div className="chat-empty-state">
            <div className="chat-empty-icon"><i className="bx bx-network-chart" /></div>
            <span className="chat-empty-label">Integraded ready</span>
            <span className="chat-empty-sub">Describe what to build — agents spawn and work in parallel</span>
            <div className="chat-empty-tips">
              <span><i className="bx bx-plus-circle" /> Use + to add a terminal</span>
              <span><i className="bx bx-list-check" /> Tool calls appear inline</span>
            </div>
          </div>
        ) : (
          msgs.map(m => {
            const isUser = m.role === "user";
            if (isUser) {
              return (
                <div key={m.id} className="chat-msg user">
                  <div className="chat-bubble-user">
                    <div className="chat-bubble-body">
                      {formatBody(m.body)}
                      {renderAttachments(m.attachments)}
                    </div>
                  </div>
                  <div className="chat-user-ts">{m.ts}</div>
                </div>
              );
            }
            // ── Tool call messages: compact strip, no avatar/bubble ──────────
            if (m.agent === "tool" && m.toolLog) {
              return (
                <div key={m.id} className="chat-msg-tool-strip">
                  {renderToolStrip(m.toolLog, m.ts)}
                </div>
              );
            }

            // ── Skill messages: compact strip, no avatar/bubble ───────────────
            if (m.agent === "skill") {
              return (
                <div key={m.id} className="chat-msg-skill-strip">
                  {m.skillLog ? (
                    <div className={`skill-strip skill-strip-${m.skillLog.status}`}>
                      <i className="bx bx-extension skill-strip-icon" />
                      <span className="skill-strip-chips">
                        {m.skillLog.skills.map(s => (
                          <span key={s.slug} className="skill-strip-chip">{s.name}</span>
                        ))}
                      </span>
                      {m.skillLog.agentLabel && m.skillLog.agentLabel !== "chat" && (
                        <><span className="skill-strip-sep">→</span><span className="skill-strip-target">{m.skillLog.agentLabel}</span></>
                      )}
                      <span className="skill-strip-badge">{
                        m.skillLog.status === "file_written" ? "files written" :
                        m.skillLog.status === "detected" ? "detected" :
                        m.skillLog.status === "failed" ? "failed" : "injected"
                      }</span>
                      <span className="skill-strip-ts">{m.ts}</span>
                    </div>
                  ) : (
                    <div className="skill-strip">
                      <i className="bx bx-extension skill-strip-icon" />
                      <span className="skill-strip-chips">
                        {m.body.split("|").map((name, i) => (
                          <span key={i} className="skill-strip-chip">{name.trim()}</span>
                        ))}
                      </span>
                      <span className="skill-strip-badge">applied</span>
                      <span className="skill-strip-ts">{m.ts}</span>
                    </div>
                  )}
                </div>
              );
            }

            return (
              <div key={m.id} className={`chat-msg ${m.agent || "ai"}`}>
                <div className="chat-msg-ai-wrap">
                  <span className={`chat-avatar ${m.agent || "ai"}`}>
                    {m.agent === "system" ? (
                      <i className="bx bx-comment-dots" />
                    ) : m.agent === "tool" ? (
                      <i className="bx bx-list-check" />
                    ) : m.agent === "diff" ? (
                      <i className="bx bx-git-compare" />
                    ) : (
                      <img src="/logo.png" className="chat-avatar-logo" alt="" />
                    )}
                  </span>
                  <div className="chat-msg-ai-content">
                <div className="chat-msg-meta">
                  <span className="chat-sender">{m.agent === "system" ? "Agent" : m.agent === "tool" ? "Tool call" : m.agent === "diff" ? "Diff view" : "Integraded"}</span>
                  <span className="chat-ts">{m.ts}</span>
                </div>
                <div className={`chat-bubble-ai${m.agent === "system" ? " system-msg" : ""}${m.agent === "tool" ? " tool-msg" : ""}${m.agent === "diff" ? " diff-msg" : ""}`}>
                      {m.thinking && (
                        <div className={`chat-thinking ${m.thinking.open ? "open" : ""}`}>
                          <button type="button" className="chat-thinking-head" onClick={() => !m.streaming && toggleThinking(m.id)} disabled={!!m.streaming}>
                            <span>Thought - {(m.thinking.elapsedMs / 1000).toFixed(1)}s</span>
                            <i className={`bx bx-chevron-${m.thinking.open ? "up" : "down"}`} />
                          </button>
                          {m.thinking.open && <div className="chat-thinking-body">{m.thinking.text}</div>}
                        </div>
                      )}
                  <div className="chat-bubble-body">
                    {m.agent === "tool" && m.toolLog
                        ? renderToolLog(m.toolLog)
                        : m.agent === "diff" && m.diffLog
                          ? renderDiffLog(m.diffLog)
                          : m.streaming && !m.body
                            ? <div className="chat-typing"><span/><span/><span/></div>
                            : (m.body ? formatBody(m.body) : null)}
                        {renderAttachments(m.attachments)}
                        {m.streaming && m.body && <span className="chat-stream-cursor" />}
                        {(m as any).pendingApproval && (
                          <div className="chat-approval-btns">
                            <button
                              className="stng-btn stng-btn-primary"
                              style={{ fontSize: "11.5px", padding: "5px 12px" }}
                              onClick={() => {
                                const { approvalId, logId: aLogId } = (m as any).pendingApproval;
                                const executor = pendingApprovalsRef.current.get(approvalId);
                                if (executor) { executor(); pendingApprovalsRef.current.delete(approvalId); }
                                setMsgs(p => p.map(x => x.id === m.id ? { ...x, pendingApproval: undefined, body: x.body + "\n\n✅ **Approved**" } : x));
                                updateToolLog(aLogId, "running", "Approved");
                              }}
                            >Allow</button>
                            <button
                              className="stng-btn stng-btn-ghost"
                              style={{ fontSize: "11.5px", padding: "5px 12px", color: "var(--err)" }}
                              onClick={() => {
                                const { approvalId, logId: aLogId, denyLabel } = (m as any).pendingApproval;
                                pendingApprovalsRef.current.delete(approvalId);
                                setMsgs(p => p.map(x => x.id === m.id ? { ...x, pendingApproval: undefined, body: x.body + "\n\n❌ **Denied**" } : x));
                                updateToolLog(aLogId, "failed", `${denyLabel} denied by user`);
                                decrementPendingDirectActions();
                              }}
                            >Deny</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}

        {isProcessing && !msgs.some(m => m.streaming) && (
          <div className="chat-typing-indicator-minimal">
            <span className="pulse-dot-small" />
            <span>Thinking...</span>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {!chatAtBottom && (
        <button
          type="button"
          className="chat-scroll-bottom"
          onClick={() => scrollChatToBottom("smooth")}
          title="Jump to latest message"
        >
          <i className="bx bx-down-arrow-alt" />
        </button>
      )}
      </div>

      {/* ── Composer — Mission Control Console ── */}
      <form className="chat-composer" onSubmit={send}>
        <div className="chat-composer-inner">
          <div className="chat-input-box">
            {composerAttachments.length > 0 && (
              <div className="chat-composer-attachments">
                {composerAttachments.map(att => (
                  <span key={att.id} className="chat-composer-attachment">
                    <i className={`bx ${att.type === "image" ? "bx-image" : "bx-file"}`} />
                    <span>{att.name}</span>
                    <button type="button" onClick={() => setComposerAttachments(prev => prev.filter(x => x.id !== att.id))}>
                      <i className="bx bx-x" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="chat-textarea-wrap">
              <textarea
                ref={textareaRef}
                className="chat-textarea"
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={isRecording ? "Listening…" : "Describe the task… (use @ to mention a file)"}
                rows={1}
                disabled={isRecording || isProcessing}
              />
            </div>
            {/* Mention dropdown — rendered outside input-box to escape overflow:hidden */}
            {mentionSuggestions.length > 0 && (() => {
              const rect = textareaRef.current?.getBoundingClientRect();
              if (!rect) return null;
              return (
                <div
                  className="chat-mention-dropdown"
                  style={{ position: "fixed", bottom: window.innerHeight - rect.top + 6, left: rect.left, width: Math.min(rect.width, window.innerWidth - rect.left - 6), minWidth: 180 }}
                >
                  {mentionSuggestions.map((f, i) => (
                    <button
                      key={f.path}
                      type="button"
                      className={`chat-mention-item ${i === mentionIndex ? "active" : ""}`}
                      onMouseDown={e => { e.preventDefault(); insertMention(f); }}
                    >
                      <i className="bx bx-file-blank chat-mention-icon" />
                      <span className="chat-mention-name">{f.name}</span>
                      <span className="chat-mention-path">{f.path.replace(/\\/g, "/").split("/").slice(-3, -1).join("/")}</span>
                    </button>
                  ))}
                  <div className="chat-mention-hint"><kbd>↑↓</kbd> navigate · <kbd>Tab</kbd> insert · <kbd>Esc</kbd> close</div>
                </div>
              );
            })()}

            <div className="chat-toolbar">
              {/* ── Spec strip (left): model + mode ── */}
              <div className="chat-spec-strip">
                <div className="chat-model-pill" ref={modelDropdownRef}>
                  <button
                    ref={pillBtnRef}
                    type="button"
                    className="chat-pill-btn"
                    onClick={() => {
                      setModelDropdownOpen(o => {
                        if (!o) {
                          setModelSearch("");
                          const rect = pillBtnRef.current?.getBoundingClientRect();
                          if (rect) {
                            setDropdownPos({
                              top: rect.top - 8,
                              left: Math.max(8, rect.left),
                            });
                          }
                        }
                        return !o;
                      });
                    }}
                  >
                    <span className="chat-pill-key">model</span>
                    <i className="bx bx-chip chat-pill-icon" />
                    <span className="chat-model-name" title={selectedModel || 'model'}>{selectedModel ? selectedModel.split('/').pop() : 'model'}</span>
                    <i className={`bx bx-chevron-up chat-pill-caret ${modelDropdownOpen ? 'open' : ''}`} />
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
                        <input
                          type="text"
                          placeholder="Search… or #provider to filter"
                          value={modelSearch}
                          onChange={e => setModelSearch(e.target.value)}
                          autoFocus
                          onKeyDown={e => e.stopPropagation()}
                        />
                        {modelSearch && (
                          <button className="chat-pill-search-clear" onClick={() => setModelSearch("")} title="Clear">
                            <i className="bx bx-x" />
                          </button>
                        )}
                        <button
                          className="chat-pill-search-clear"
                          title="Refresh all models"
                          onClick={() => setModelRefreshTick(t => t + 1)}
                          disabled={modelRefreshing}
                        >
                          <i className={`bx bx-refresh ${modelRefreshing ? "bx-spin" : ""}`} />
                        </button>
                      </div>
                      <div className="chat-pill-scroll">
                        {(() => {
                          const raw = modelSearch.toLowerCase().trim();
                          // #provider filter: "#openai" → show only models from openai
                          const isProviderFilter = raw.startsWith("#");
                          const providerQ = isProviderFilter ? raw.slice(1) : "";
                          const textQ = isProviderFilter ? "" : raw;
                          const filt = models.filter(m => {
                            if (isProviderFilter) {
                              return !providerQ ||
                                m.provider.toLowerCase().includes(providerQ) ||
                                m.providerName.toLowerCase().includes(providerQ);
                            }
                            return !textQ ||
                              m.value.toLowerCase().includes(textQ) ||
                              (m.label || "").toLowerCase().includes(textQ) ||
                              m.providerName.toLowerCase().includes(textQ);
                          });
                          const providerOrder: string[] = [];
                          const byProvider = new Map<string, ModelEntry[]>();
                          for (const m of filt) {
                            if (!byProvider.has(m.provider)) {
                              byProvider.set(m.provider, []);
                              providerOrder.push(m.provider);
                            }
                            byProvider.get(m.provider)!.push(m);
                          }
                          // When typing just "#" with no text, show all providers grouped + local status
                          const localOnlineProviders = ["ollama", "lmstudio"];
                          if (!providerOrder.length && isProviderFilter && !providerQ) {
                            // show all available providers as hints
                            const allProvs = Array.from(new Set(models.map(m => m.provider)));
                            return allProvs.length === 0
                              ? <div className="chat-pill-empty">No models loaded yet</div>
                              : <div style={{ padding: "8px 10px", fontSize: "11px", color: "var(--text-3)" }}>
                                  {allProvs.map(p => {
                                    const name = models.find(m => m.provider === p)?.providerName || p;
                                    const isLocal = localOnlineProviders.includes(p);
                                    const online = isLocal ? localProviderOnline[p] : true;
                                    return (
                                      <span
                                        key={p}
                                        className="chat-pill-provider-chip"
                                        onClick={() => setModelSearch(`#${p} `)}
                                      >
                                        <span className={`chat-pill-dot ${online ? "online" : "offline"}`} />
                                        {name}
                                      </span>
                                    );
                                  })}
                                </div>;
                          }
                          if (!providerOrder.length) return <div className="chat-pill-empty">No models found</div>;
                          return providerOrder.map(prov => {
                            const items = byProvider.get(prov)!;
                            const providerName = items[0].providerName;
                            const isLocal = localOnlineProviders.includes(prov);
                            const online = isLocal ? localProviderOnline[prov] : true;
                            return (
                              <div key={prov} className="chat-pill-group">
                                <div className="chat-pill-group-label">
                                  {isLocal && (
                                    <span
                                      className={`chat-pill-dot ${online ? "online" : "offline"}`}
                                      title={online ? "Server online" : "Server offline"}
                                    />
                                  )}
                                  {providerName}
                                  {isLocal && !online && <span style={{ marginLeft: 4, color: "var(--err)", fontSize: "10px" }}>(offline)</span>}
                                </div>
                                {items.map(m => {
                                  const isActive = m.value === selectedModel && m.provider === selectedCloudProvider;
                                  return (
                                    <button
                                      key={`${m.provider}::${m.value}`}
                                      type="button"
                                      className={`chat-pill-item ${isActive ? "active" : ""}`}
                                      onClick={() => { selectModel(m.value, m.provider); setModelDropdownOpen(false); }}
                                    >
                                      <span className="chat-pill-item-text">{m.label || m.value.split("/").pop()}</span>
                                      {isActive && <i className="bx bx-check" />}
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  )}
                </div>

                <span className="chat-toolbar-divider" aria-hidden="true" />

                <div className="chat-mode-pill" ref={modeDropdownRef} title="Choose how the chatbot handles the next message">
                  <button
                    ref={modeBtnRef}
                    type="button"
                    className={`chat-pill-btn chat-mode-btn chat-mode-${chatMode}`}
                    onClick={() => {
                      setModeDropdownOpen(o => {
                        if (!o) {
                          const rect = modeBtnRef.current?.getBoundingClientRect();
                          if (rect) {
                            setModeDropdownPos({
                              top: rect.top - 8,
                              left: Math.max(8, Math.min(rect.left, window.innerWidth - 190)),
                            });
                          }
                        }
                        return !o;
                      });
                    }}
                  >
                    <span className="chat-pill-key">mode</span>
                    <span className="chat-mode-name">{chatMode === "build" ? "Build" : "Plan"}</span>
                    <i className={`bx bx-chevron-up chat-pill-caret ${modeDropdownOpen ? "open" : ""}`} />
                  </button>
                  {modeDropdownOpen && modeDropdownPos && (
                    <div
                      className="chat-pill-dropdown chat-mode-dropdown"
                      data-mode-dropdown="true"
                      style={{
                        top: modeDropdownPos.top,
                        left: modeDropdownPos.left,
                        transform: "translateY(-100%)",
                      }}
                    >
                      {([
                        { value: "build" as const, label: "Build", icon: "bx-cog", desc: "Coordinate agents and implement" },
                        { value: "plan" as const, label: "Plan", icon: "bx-notepad", desc: "Draft an implementation plan in chat" },
                      ]).map(option => (
                        <button
                          key={option.value}
                          type="button"
                          className={`chat-pill-item chat-mode-item ${chatMode === option.value ? "active" : ""}`}
                          onClick={() => {
                            setChatMode(option.value);
                            setModeDropdownOpen(false);
                          }}
                        >
                          <i className={`bx ${option.icon} chat-mode-icon`} />
                          <span className="chat-pill-item-text">
                            <strong>{option.label}</strong>
                            <small>{option.desc}</small>
                          </span>
                          {chatMode === option.value && <i className="bx bx-check chat-mode-check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* ── Utility cluster (right): attach + mic + send ── */}
              <div className="chat-utility-cluster">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.jsx,.css,.html"
                  className="chat-file-input"
                  onChange={event => attachFiles(event.target.files)}
                />
                <button
                  type="button"
                  className="chat-utility-btn"
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach image or file"
                  aria-label="Attach file"
                >
                  <i className="bx bx-paperclip" />
                </button>
                <button
                  type="button"
                  className={`chat-utility-btn ${isRecording ? "recording" : ""}`}
                  onClick={toggleRecording}
                  title={isRecording ? "Stop recording" : "Voice input"}
                  aria-label={isRecording ? "Stop recording" : "Voice input"}
                >
                  <i className={`bx bx-microphone${isRecording ? "-off" : ""}`} />
                  {isRecording && <span className="chat-utility-pulse" aria-hidden="true" />}
                </button>

                <span className="chat-toolbar-divider chat-toolbar-divider-end" aria-hidden="true" />

                {isProcessing ? (
                  <button type="button" className="chat-send-btn stop" onClick={handleStop} title="Stop" aria-label="Stop">
                    <i className="bx bx-stop" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="chat-send-btn"
                    disabled={!input.trim() && composerAttachments.length === 0}
                    title="Send (Enter)"
                    aria-label="Send message"
                  >
                    <span className="chat-send-btn-label">SEND</span>
                    <i className="bx bx-send chat-send-btn-icon" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
};
