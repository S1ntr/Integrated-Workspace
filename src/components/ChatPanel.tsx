import React, { useState, useEffect, useRef } from "react";
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
  type: "spawn" | "send" | "broadcast" | "kill" | "request" | "ask_user" | "browser_open" | "mode" | "file_create";
  agentType?: string;
  label: string;
  prompt?: string;
  count?: number;
  reason?: string;
  question?: string;
  url?: string;
  device?: string;
  mode?: string;
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

interface Msg {
  id: string;
  role: "ai" | "user";
  body: string;
  ts: string;
  streaming?: boolean;
  agent?: "orchestrator" | "system" | "tool" | "diff";
  actions?: AgentAction[];
  attachments?: ChatAttachment[];
  toolLog?: ToolCallLog;
  diffLog?: DiffLog;
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
  labels: string[];
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
  ollama_cloud: [
    { value: "gpt-oss:120b", label: "GPT OSS 120B" },
    { value: "gpt-oss:20b", label: "GPT OSS 20B" },
  ],
};

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic", deepseek: "DeepSeek",
  mistral: "Mistral", google: "Google", grok: "Grok",
  together: "Together AI", openrouter: "OpenRouter", ollama_cloud: "Ollama Cloud",
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

function parseStreamDelta(line: string, provider: string): string | null {
  if (!line.trim()) return null;
  if (provider === "ollama" || provider === "ollama_cloud") {
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

function parseStreamThinking(line: string, provider: string): string | null {
  if (!line.trim()) return null;
  try {
    if (provider === "ollama" || provider === "ollama_cloud") {
      const d = JSON.parse(line);
      return d.message?.thinking || d.message?.reasoning || d.thinking || d.reasoning || null;
    }
    if (provider === "anthropic") {
      const d = JSON.parse(line);
      return d.delta?.thinking || d.delta?.text_delta?.thinking || null;
    }
    if (line.startsWith("data: ")) {
      const j = line.slice(6).trim();
      if (j === "[DONE]") return null;
      const d = JSON.parse(j);
      const delta = d.choices?.[0]?.delta || {};
      return delta.reasoning_content || delta.reasoning || delta.thinking || null;
    }
  } catch {
    return null;
  }
  return null;
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

function detectAgentCompletionSummary(text: string): string | null {
  const cleaned = stripAnsi(text).trim();
  if (!cleaned) return null;
  const lines = cleaned.split("\n").map(l => l.trim()).filter(Boolean).slice(-18);
  const joined = lines.join("\n");
  if (detectTerminalQuestion(joined)) return null;
  if (looksLikeTerminalNoise(joined)) return null;
  if (!/\b(summary|changes made|task complete|completed|finished|all set|done|implemented|fixed)\b/i.test(joined)) {
    return null;
  }
  if (/\b(let me|i will|i'll|going to|updating todos|checking|reading)\b/i.test(lines.slice(-4).join(" "))) {
    return null;
  }
  const summaryLines = lines
    .filter(line => !/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line))
    .filter(line => !/^thought:?/i.test(line))
    .filter(line => !looksLikeTerminalNoise(line))
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
): string {
  const sessionList = sessions.length > 0
    ? sessions.map(s => `- ${s.label} (${s.command})`).join("\n")
    : "(none — use spawn actions to create terminals)";

  const outputBlocks = sessions
    .filter(s => outputs[s.sessionId]?.trim() || transcripts[s.sessionId]?.length)
    .map(s => {
      const structured = (transcripts[s.sessionId] || []).slice(-18).map(entry => {
        const prefix = entry.kind === "input" ? "user->agent" : entry.kind;
        return `${prefix}: ${entry.text.replace(/\s+/g, " ").slice(-700)}`;
      }).join("\n");
      const fallback = (outputs[s.sessionId] || "").slice(-1200).trim();
      return `### ${s.label} (${s.command}, ${s.status || "unknown"})\n\`\`\`\n${structured || fallback}\n\`\`\``;
    })
    .join("\n\n");

  const recentTools = toolCalls.slice(-12).map(t =>
    `- ${t.ts} ${t.action.type.toUpperCase()} ${t.action.label} [${t.status}]${t.note ? `: ${t.note}` : ""}`
  ).join("\n");

  const questionBlocks = pendingQuestions.filter(q => !q.answered).slice(-5).map(q =>
    `- ${q.label}: ${q.question}`
  ).join("\n");

  return `You are the **Orchestrator** in "Integraded" — an integrated multi-agent development workspace.

## Role
Break user requests into parallel sub-tasks. Dispatch each to dedicated CLI coding agents in real terminals, monitor their transcript, answer their follow-up questions when the user's intent is clear, and ask the user when it is not.

## Active Sessions
${sessionList}

## Available Agent Types
- \`claude\` — Anthropic Claude CLI (complex coding, architecture)
- \`opencode\` — opencode.ai (fast, focused file tasks)
- \`codex\` — OpenAI Codex CLI
- \`shell\` — PowerShell/bash (commands, installs, scripts)
- \`antigravity\` — Antigravity CLI

## Tool Calls
Tool calls execute automatically. Raw tool call syntax is hidden from the normal chat bubble and the app renders an inline log message instead. Prefer this exact XML form:

<tool_call>{"tool":"agent.send","label":"Existing Agent Label","prompt":"Message to send to the CLI agent"}</tool_call>
<tool_call>{"tool":"agent.spawn","agentType":"opencode","label":"Frontend Agent","prompt":"Focused task for this new agent"}</tool_call>
<tool_call>{"tool":"agent.broadcast","label":"all","prompt":"Shared coordination update for every useful open agent"}</tool_call>
<tool_call>{"tool":"agent.request","agentType":"claude","label":"Review Agent","count":1,"reason":"Need another reviewer","prompt":"Task to send once the user adds that agent"}</tool_call>
<tool_call>{"tool":"agent.mode","label":"Existing Agent Label","agentType":"codex","reason":"Switch this terminal to Codex CLI"}</tool_call>
<tool_call>{"tool":"agent.kill","label":"Agent Label"}</tool_call>
<tool_call>{"tool":"browser.open","url":"http://localhost:3000","device":"responsive","mode":"app","label":"Project Preview"}</tool_call>
<tool_call>{"tool":"chat.ask_user","question":"Precise question for the user"}</tool_call>

If your model has trouble with XML, a fenced JSON block named tool_call is also accepted. Never show raw tool calls in visible prose. Visible prose should summarize what is happening and what you need from the user.

## Coordination Rules
1. **REUSE ACTIVE SESSIONS**: ALWAYS prefer sending tasks to already active sessions. If a running active session (e.g. "HTML Builder" or "CSS Stylist") listed under "Active Sessions" above can handle the task, use \`agent.send\` to send the prompt to it. Do not spawn a new session if a matching/compatible session already exists.
2. Unique descriptive labels: "HTML Builder", "CSS Stylist", "JS Developer", etc.
3. Each agent gets ONE focused task with FULL context: file names, shared types, conventions
4. Never assign two agents to the same file
5. If agent A defines a shared type, paste the full definition into agent B's prompt
6. If more agents are needed but you should not create them yourself, use \`agent.request\`; the app will detect newly added matching agents and dispatch your queued prompt.
7. If a CLI agent asks a question and the answer follows from the user's instruction, answer it with \`agent.send\`. If uncertain, use \`chat.ask_user\`.
8. If the user asks to open, inspect, test, or preview a web/app UI, use \`browser.open\` with the best local URL from terminal output. If no URL is known, ask the user for it.
9. Browser feedback may include a URL, viewport, selected element/region, and user note. Use that context to prompt agents with precise visual/UI fixes.
10. When an agent finishes, convert its terminal output into a concise visible summary of changed files, integrations, tests, and remaining risks. Do not show a question card unless the terminal is clearly waiting for user input.
11. After dispatching, briefly summarize what each agent is doing (visible to user)
12. The user may mention files with @filename, @path/file, or quoted @"path with spaces". Pass exact resolved paths to agents and tell them to inspect those files before editing. If a mention is unresolved, tell the agent to locate it with workspace search before touching files.
13. Default to parallel coordination for non-trivial build/fix requests. When 2+ compatible agents are active and the work can be separated by file, layer, test, or review responsibility, emit multiple tool calls in the same response: one focused \`agent.send\` or \`agent.spawn\` per useful agent. Do not stop after assigning the first agent.
14. Use all helpful active agents when possible, with non-overlapping ownership. Good splits include UI/CSS, data/API, tests/build, bug diagnosis, docs, and review. Only use a single agent when the task is clearly tiny, single-file, or unsafe to parallelize.
15. After dispatching, keep monitoring all terminal transcripts. If agents ask simple confirmation/follow-up questions that are answered by the user's instructions, answer them with \`agent.send\`. If not clear, use \`chat.ask_user\`.
16. When all dispatched agents are quiet and no unanswered questions remain, provide one concise final project-ready summary with changed files, verification, risks, and run/preview hints. Avoid repeating noisy terminal UI output.

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
): string {
  const changed = changedFiles.slice(0, 14)
    .map(file => `- ${file.status}: ${file.path}`)
    .join("\n");

  return `You are the planning mode inside Integraded Chat.

Create a practical implementation plan for the user's request. This mode is handled entirely in chat:
- Do not call CLI agents.
- Do not emit tool calls.
- Do not ask another agent to do work.
- Produce a concise but useful plan with concrete files, phases, risks, and verification steps.
- If the user mentioned files with @filename, use the attached file contents/paths in your plan.
- End by asking whether the user wants this plan saved as a Markdown implementation file.

Preferred structure:
## Goal
## Implementation Plan
## Files To Touch
## Verification
## Risks / Questions

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

function summarySignature(text: string): string {
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

function buildAgentsReadySummary(
  monitor: WorkMonitor,
  sessions: Session[],
  outputs: Record<string, string>,
  changedFiles: ChatDiffFile[],
): string {
  const labels = monitor.labels.length ? monitor.labels.join(", ") : `${monitor.actions} agent action${monitor.actions === 1 ? "" : "s"}`;
  const files = changedFiles.slice(0, 10).map(file => `- ${file.status === "new" ? "NEW" : "MOD"} ${file.name}`);
  const urls = extractLocalUrls(outputs).map(url => `- ${url}`);
  const active = sessions.map(s => `- ${s.label} (${s.status || "unknown"})`).slice(0, 8);
  return [
    "**Agents look done**",
    "",
    "No terminal has produced fresh activity for a moment and there are no open agent questions.",
    "",
    `**Coordinated work**: ${labels}`,
    active.length ? `\n**Sessions**\n${active.join("\n")}` : "",
    files.length ? `\n**Changed files**\n${files.join("\n")}${changedFiles.length > files.length ? `\n- ...and ${changedFiles.length - files.length} more` : ""}` : "",
    urls.length ? `\n**Local preview**\n${urls.join("\n")}` : "",
    "\nOpen `Changes` to review the diff before you run or commit it.",
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
  const [currentChatMeta, setCurrentChatMeta] = useState<ChatSessionMeta>(() => createChatMeta());
  const historyRef = useRef<HTMLDivElement>(null);

  // ── Terminal picker ──────────────────────────────────────────────────────────
  const [termPickerOpen, setTermPickerOpen] = useState(false);
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
  const [chatMode, setChatMode] = useState<"build" | "plan">("build");
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
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
  const seenQuestionKeysRef = useRef<Set<string>>(new Set());
  const seenSummaryKeysRef = useRef<Set<string>>(new Set());
  const lastSummaryBySessionRef = useRef<Record<string, { sig: string; at: number }>>({});
  const lastDiffSignatureRef = useRef("");
  const lastReadySummaryRef = useRef("");
  const usedPromptSessionIdsRef = useRef<Set<string>>(new Set());
  const handledExternalPromptRef = useRef<string | null>(null);
  const lastContextMsgIdRef = useRef<string | null>(null);
  const currentChatMetaRef = useRef(currentChatMeta);
  
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
    if (chatAtBottomRef.current) requestAnimationFrame(() => scrollChatToBottom("smooth"));
    requestAnimationFrame(() => {
      const bodies = chatPanelRef.current?.querySelectorAll<HTMLElement>(".chat-thinking.open .chat-thinking-body");
      bodies?.forEach(body => {
        body.scrollTop = body.scrollHeight;
      });
    });
  }, [msgs]);

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
    } catch {}
  };
  useEffect(() => {
    loadConfig();
    window.addEventListener("__integradedConfigUpdated", loadConfig);
    return () => window.removeEventListener("__integradedConfigUpdated", loadConfig);
  }, [chatScopeKey]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const raw = await invoke<string | null>("load_chat_history", { scope: chatScopeKey });
        if (!active) return;
        if (raw) {
          const payload = JSON.parse(raw);
          const diskHistories = Array.isArray(payload.histories)
            ? payload.histories.map(normalizeHistory).filter(Boolean) as ChatHistory[]
            : [];
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
            setMsgs(normalizeMessages(payload.current_msgs));
            setContextWindow(typeof payload.current_context === "string" ? payload.current_context : "");
          }
          if (diskHistories.length) setHistories(diskHistories);
        }
      } catch {
        // LocalStorage initializers already provide an offline fallback.
      } finally {
        if (active) setHistoryHydrated(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const buildHistoryPayload = (nextMsgs = msgs, nextContext = contextWindow, nextHistories = histories) => {
    const cleanMsgs = normalizeMessages(nextMsgs);
    const currentName = cleanMsgs.find(m => m.role === "user")?.body.slice(0, 60) || "Current chat";
    return JSON.stringify({
      current_msgs: cleanMsgs,
      current_context: nextContext,
      current_session: {
        ...currentChatMetaRef.current,
        name: currentName,
        msgs: cleanMsgs,
        contextWindow: nextContext,
      },
      histories: nextHistories.map(h => ({ ...h, msgs: normalizeMessages(h.msgs) })),
    });
  };

  // Persistence synchronizations
  useEffect(() => {
    if (!historyHydrated) return;
    try {
      localStorage.setItem(storageKey("current_msgs"), JSON.stringify(normalizeMessages(msgs)));
    } catch {}
    const payload = buildHistoryPayload(msgs, contextWindow, histories);
    invoke("save_chat_history", { jsonData: payload, scope: chatScopeKey }).catch(() => {});
  }, [msgs, contextWindow, historyHydrated, chatScopeKey]);

  useEffect(() => {
    if (!historyHydrated) return;
    try {
      localStorage.setItem(storageKey("histories"), JSON.stringify(histories));
    } catch {}
    const payload = buildHistoryPayload(msgs, contextWindow, histories);
    invoke("save_chat_history", { jsonData: payload, scope: chatScopeKey }).catch(() => {});
  }, [histories, contextWindow, msgs, currentChatMeta, historyHydrated, chatScopeKey]);

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
      // Use ref to avoid stale closure — selectedModelRef.current always has the latest value
      if (!result.some(m => m.value === selectedModelRef.current) && result.length > 0) {
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
    setMsgs(prev => [
      ...prev,
      ...additions.map(q => ({
        id: q.id,
        role: "ai" as const,
        agent: "system" as const,
        body: `**${q.label} asks:** ${q.question}\n\nMůžeš odpovědět přímo tady v chatu, nebo použít tlačítko u otázky pro poslání rozepsané odpovědi do terminálu.`,
        ts: q.ts,
      })),
    ]);
  }, [sessionsProp, terminalOutputsProp]);

  // Surface agent completion notes as summaries instead of misclassifying them as questions.
  useEffect(() => {
    const additions: Msg[] = [];
    for (const session of sessionsProp) {
      const transcript = terminalTranscriptsProp[session.sessionId] || [];
      const wasPrompted = transcript.some(entry => entry.kind === "input") || usedPromptSessionIdsRef.current.has(session.sessionId);
      if (!wasPrompted) continue;
      const summary = detectAgentCompletionSummary(terminalOutputsProp[session.sessionId] || "");
      if (!summary) continue;
      const sig = summarySignature(summary);
      const last = lastSummaryBySessionRef.current[session.sessionId];
      if (last && (last.sig === sig || last.sig.includes(sig) || sig.includes(last.sig) || Date.now() - last.at < 15000)) {
        continue;
      }
      const key = `${session.sessionId}:${sig}`;
      if (seenSummaryKeysRef.current.has(key)) continue;
      seenSummaryKeysRef.current.add(key);
      lastSummaryBySessionRef.current[session.sessionId] = { sig, at: Date.now() };
      additions.push({
        id: `sum-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "ai",
        agent: "orchestrator",
        body: `**${session.label} summary**\n${summary}`,
        ts: ts(),
      });
    }
    if (additions.length) setMsgs(prev => [...prev, ...additions]);
  }, [sessionsProp, terminalOutputsProp, terminalTranscriptsProp]);

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
            labels: [session.label],
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
      if (!relevant.length) return;
      const lastActivity = Math.max(...relevant.map(entry => entry.ts), workMonitor.startedAt);
      if (Date.now() - lastActivity < 9000) return;
      if (agentQuestionsRef.current.some(q => !q.answered)) return;
      if (isProcessingRef.current) return;

      const signature = `${workMonitor.id}:${lastActivity}:${changedFilesRef.current.length}`;
      if (lastReadySummaryRef.current === signature) return;
      lastReadySummaryRef.current = signature;
      const body = buildAgentsReadySummary(
        workMonitor,
        sessionsRef.current,
        terminalOutputsRef.current,
        changedFilesRef.current,
      );
      setMsgs(prev => [...prev, {
        id: `ready-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "ai",
        agent: "orchestrator",
        body,
        ts: ts(),
      }]);
      setWorkMonitor(null);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [workMonitor]);

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
    if (prov === "ollama_cloud") {
      return {
        provider: "ollama_cloud",
        url: "https://ollama.com/api/chat",
        body: JSON.stringify({ model, messages, stream: streaming }),
        headers: [["Authorization", `Bearer ${key}`], ["Content-Type", "application/json"]] as string[][],
      };
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
    streamThinkingRef.current = "";
    streamThinkingStartRef.current = null;
    streamThinkingElapsedRef.current = null;

    streamUnlistenRef.current = (await listen<string>(`stream-chunk-${sid}`, (e) => {
      if (activeStreamIdRef.current !== sid) return;
      const thinkingDelta = parseStreamThinking(e.payload, req.provider);
      if (thinkingPreviewEnabled && thinkingDelta) {
        if (streamThinkingStartRef.current === null) streamThinkingStartRef.current = Date.now();
        streamThinkingRef.current += thinkingDelta;
        const thinkingStart = streamThinkingStartRef.current ?? Date.now();
        const elapsedMs = Date.now() - thinkingStart;
        setMsgs(p => p.map(m => m.id === msgId ? {
          ...m,
          thinking: { text: streamThinkingRef.current, elapsedMs, open: m.thinking?.open ?? true, done: false },
        } : m));
      }
      const delta = parseStreamDelta(e.payload, req.provider);
      if (delta) {
        streamTextRef.current += delta;
        const hadThinking = streamThinkingStartRef.current !== null || streamThinkingRef.current.length > 0;
        const justFinishedThinking = hadThinking && streamThinkingElapsedRef.current === null;
        if (justFinishedThinking) {
          streamThinkingElapsedRef.current = Math.max(0, Date.now() - (streamThinkingStartRef.current ?? Date.now()));
        }
        const elapsedMs = streamThinkingElapsedRef.current ?? 0;
        setMsgs(p => p.map(m => m.id === msgId ? {
          ...m,
          body: visibleStreamText(streamTextRef.current),
          thinking: thinkingPreviewEnabled && hadThinking
            ? { text: streamThinkingRef.current, elapsedMs, open: justFinishedThinking ? false : (m.thinking?.open ?? false), done: true }
            : m.thinking,
        } : m));
      }
    })) as unknown as () => void;

    try {
      await invoke("curl_post_stream", { url: req.url, body: req.body, headers: req.headers, sessionId: sid });
    } finally {
      activeStreamIdRef.current = null;
      streamUnlistenRef.current?.();
      streamUnlistenRef.current = null;
      const hadThinking = streamThinkingStartRef.current !== null || streamThinkingRef.current.length > 0;
      const elapsedMs = streamThinkingElapsedRef.current ?? (hadThinking ? Math.max(0, Date.now() - (streamThinkingStartRef.current ?? Date.now())) : 0);
      streamThinkingElapsedRef.current = elapsedMs;
      setMsgs(p => p.map(m => m.id === msgId ? {
        ...m,
        streaming: false,
        body: visibleStreamText(streamTextRef.current),
        thinking: thinkingPreviewEnabled && hadThinking
          ? { text: streamThinkingRef.current, elapsedMs, open: m.thinking?.open ?? false, done: true }
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
    const hadThinking = streamThinkingStartRef.current !== null || streamThinkingRef.current.length > 0;
    const elapsedMs = streamThinkingElapsedRef.current ?? (hadThinking ? Math.max(0, Date.now() - (streamThinkingStartRef.current ?? Date.now())) : 0);
    streamThinkingElapsedRef.current = elapsedMs;
    setMsgs(p => p.map(m => m.streaming ? {
      ...m,
      streaming: false,
      body: visibleStreamText(streamTextRef.current),
      thinking: hadThinking && m.thinking ? { ...m.thinking, elapsedMs, open: m.thinking.open, done: true } : m.thinking,
    } : m));
  };

  const callLLM = async (messages: { role: string; content: string }[]): Promise<string> => {
    const req = buildRequest(messages, false);
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

  const sendToSession = (session: Session, promptText: string, logId: string) => {
    usedPromptSessionIdsRef.current.add(session.sessionId);
    if (session.status === "exited") {
      const newSessId = onRestartSessionRef.current?.(session.id);
      if (!newSessId) {
        updateToolLog(logId, "failed", "Could not restart exited session.");
        return;
      }
      updateToolLog(logId, "queued", `Restarting ${session.label}.`);
      setTimeout(() => {
        onSendPtyCommandRef.current?.(newSessId, promptText);
        updateToolLog(logId, "done", `Sent to restarted ${session.label}.`);
      }, 4000);
      return;
    }
    if (session.status === "booting") {
      updateToolLog(logId, "queued", `Waiting for ${session.label} to boot.`);
      setTimeout(() => {
        onSendPtyCommandRef.current?.(session.sessionId, promptText);
        updateToolLog(logId, "done", `Sent to ${session.label}.`);
      }, 4000);
      return;
    }
    onSendPtyCommandRef.current?.(session.sessionId, promptText);
    updateToolLog(logId, "done", `Sent to ${session.label}.`);
  };

  const autoDispatchActions = (actions: AgentAction[]) => {
    const usedSessionIds = new Set<string>();
    const monitorLabels: string[] = [];

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
        onOpenBrowserRef.current({
          id: logId,
          url: action.url,
          label: action.label,
          device: action.device,
          mode: action.mode === "web" ? "web" : action.mode === "app" ? "app" : undefined,
        });
        updateToolLog(logId, "done", action.url ? `Opened ${action.url}.` : "Opened integrated browser.");
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
          monitorLabels.push(session.label);
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
          monitorLabels.push(target.label);
          setTimeout(() => onSendPtyCommandRef.current?.(newSessionId, action.prompt || ""), 4000);
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
          monitorLabels.push(target.label);
          updateToolLog(logId, "running", `Dispatching to ${target.label}.`);
          sendToSession(target, promptText, logId);
        } else if (action.type === "spawn" && action.agentType) {
          const spawned = onAddSessionRef.current?.(action.label, action.agentType);
          if (spawned && spawned.sessionId) {
            usedSessionIds.add(spawned.sessionId);
            monitorLabels.push(spawned.label);
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
          onCloseSessionRef.current?.(target.id);
          updateToolLog(logId, "done", `Closed ${target.label}.`);
        } else {
          updateToolLog(logId, "failed", "No matching session found.");
        }
      }
    }
    if (monitorLabels.length) {
      setWorkMonitor({
        id: `wm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        startedAt: Date.now(),
        actions: monitorLabels.length,
        labels: Array.from(new Set(monitorLabels)),
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
      role: m.role === "user" ? "user" as const : "assistant" as const,
      content: messageForModel(m),
    }));
    const llmMsgs = [
      { role: "system", content: buildPlanPrompt(contextWindowRef.current, changedFilesRef.current) },
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

      const sysPrompt = buildOrchestratorPrompt(
        sessionsRef.current,
        terminalOutputsRef.current,
        terminalTranscriptsRef.current,
        toolCallsRef.current,
        agentQuestionsRef.current,
        contextWindowRef.current,
      );
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
        return { role: m.role === "user" ? "user" as const : "assistant" as const, content };
      });
      const llmMsgs = [{ role:"system", content: sysPrompt }, ...history, { role:"user", content: messageForModel(userMsg) }];
      const aiMsgId = `a${Date.now()}`;

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
        if (actions.length) autoDispatchActions(actions);
      } else {
        const resp = await callLLM(llmMsgs);
        const actions = parseAgentActions(resp);
        const visible = stripAgentTags(resp);
        setMsgs(p => [...p, { id: aiMsgId, role:"ai", agent:"orchestrator", body: visible, actions: actions.length ? actions : undefined, ts: ts() }]);
        if (actions.length) autoDispatchActions(actions);
      }
    } catch (err: any) {
      const detail = err?.message || String(err || "Failed to get AI response.");
      const modelHint = selectedModelRef.current ? `\n\nModel: \`${selectedModelRef.current}\`` : "";
      setMsgs(p => [...p, {
        id:`e${Date.now()}`,
        role:"ai",
        agent:"system",
        body:`**Error:** Failed to get AI response.\n\n${detail}${modelHint}`,
        ts: ts(),
      }]);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

  const renderToolLog = (log: ToolCallLog) => {
    const note = toolLogNote(log);
    return (
      <div className={`chat-tool-message status-${log.status}`}>
        <div className="chat-tool-message-row">
          <span className="chat-tool-status">{log.status}</span>
          <span className="chat-tool-action">{log.action.type.replace("_", ".")}</span>
          <span className="chat-tool-arrow">{"->"}</span>
          <span className="chat-tool-target">{toolLogTarget(log)}</span>
        </div>
        {note && <div className="chat-tool-message-note">{note}</div>}
      </div>
    );
  };

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
            <img src="/logo.svg" className="chat-header-logo" alt="" />
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
            return (
              <div key={m.id} className={`chat-msg ${m.agent || "ai"}`}>
                <div className="chat-msg-ai-wrap">
                  <span className={`chat-avatar ${m.agent || "ai"}`}>
                    {m.agent === "system" ? (
                      <i className="bx bx-error-circle" />
                    ) : m.agent === "tool" ? (
                      <i className="bx bx-list-check" />
                    ) : m.agent === "diff" ? (
                      <i className="bx bx-git-compare" />
                    ) : (
                      <img src="/logo.svg" className="chat-avatar-logo" alt="" />
                    )}
                  </span>
                  <div className="chat-msg-ai-content">
                <div className="chat-msg-meta">
                  <span className="chat-sender">{m.agent === "system" ? "System" : m.agent === "tool" ? "Tool call" : m.agent === "diff" ? "Diff view" : "Integraded"}</span>
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
                        : (m.body ? formatBody(m.body) : null)}
                        {renderAttachments(m.attachments)}
                        {m.streaming && <span className="chat-stream-cursor" />}
                      </div>
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
              <span className="chat-avatar orchestrator"><img src="/logo.svg" className="chat-avatar-logo" alt="" /></span>
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
              placeholder={isRecording ? "Listening…" : agentQuestions.some(q => !q.answered) ? "Type an answer for the waiting agent…" : "Describe the task…"}
              rows={1}
              disabled={isRecording || isProcessing}
            />
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
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.jsx,.css,.html"
                className="chat-file-input"
                onChange={event => attachFiles(event.target.files)}
              />
              <div className="chat-mode-pill" ref={modeDropdownRef} title="Choose how the chatbot handles the next message">
                <button
                  ref={modeBtnRef}
                  type="button"
                  className="chat-pill-btn chat-mode-btn"
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
                  <span className="chat-mode-name">{chatMode === "build" ? "Build" : "Plan"}</span>
                  <i className={`bx bx-chevron-up ${modeDropdownOpen ? "open" : ""}`} />
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
                      { value: "build" as const, label: "Build", icon: null, desc: "Coordinate agents and implement" },
                      { value: "plan" as const, label: "Plan", icon: null, desc: "Draft an implementation plan in chat" },
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
                        {option.icon && <i className={`bx ${option.icon}`} />}
                        <span className="chat-pill-item-text">
                          <strong>{option.label}</strong>
                          <small>{option.desc}</small>
                        </span>
                        {chatMode === option.value && <i className="bx bx-check" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="chat-mic-btn"
                onClick={() => fileInputRef.current?.click()}
                title="Attach image or file"
              >
                <i className="bx bx-paperclip" />
              </button>
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
            <button type="submit" className="chat-send-btn" disabled={!input.trim() && composerAttachments.length === 0}>
              <i className="bx bx-send" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
};
