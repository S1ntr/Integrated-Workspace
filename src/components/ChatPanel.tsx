import React, { useState, useEffect, useRef } from "react";

interface Msg {
  id: string;
  role: "ai" | "user";
  body: string;
  ts: string;
}

interface ChatPanelProps {
  width?: number;
  embedded?: boolean;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ width, embedded }) => {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  const ts = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;

    const userMsg: Msg = { id: `u-${Date.now()}`, role: "user", body: text, ts: ts() };
    setMsgs(p => [...p, userMsg]);
    setInput("");

    // Simple contextual reply (not fake elaborate "AI" messages)
    setTimeout(() => {
      const lower = text.toLowerCase();
      let reply = "I'm listening.";
      if (lower.includes("opencode") || lower.includes("open code")) {
        reply = "opencode runs in your terminal panel — check if it's installed with `which opencode` or `where opencode`.";
      } else if (lower.includes("help")) {
        reply = "Use the terminal panels to run commands. The file explorer is on the left. This chat is for quick queries.";
      } else if (lower.includes("error")) {
        reply = "Check the terminal output. Red lines indicate stderr. Use `env` in the terminal to see workspace info.";
      }
      setMsgs(p => [...p, { id: `a-${Date.now()}`, role: "ai", body: reply, ts: ts() }]);
    }, 800);
  };

  return (
    <div className={`chat-panel ${embedded ? "embedded" : ""}`} style={embedded ? {} : { width }}>
      {!embedded && (
        <div className="chat-bar">
          <span className="chat-bar-label">
            <span className="chat-live-dot" />
            Chat
          </span>
        </div>
      )}

      <div className="chat-messages">
        {msgs.length === 0 ? (
          <div className="chat-empty-state">
            <i className="bx bx-message-square-detail" />
            <span className="chat-empty-label">No messages</span>
            <span className="chat-empty-sub">Ask about your workspace, agents or commands.</span>
          </div>
        ) : msgs.map(m => (
          <div key={m.id} className="chat-msg">
            <div className="chat-msg-meta">
              <span className={`chat-avatar ${m.role}`}>
                <i className={`bx bx-${m.role === "ai" ? "bot" : "user"}`} />
              </span>
              <span className="chat-sender">{m.role === "ai" ? "Integraded" : "You"}</span>
              <span className="chat-ts">{m.ts}</span>
            </div>
            <div className={`chat-bubble ${m.role}`}>{m.body}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form className="chat-composer" onSubmit={send}>
        <input
          className="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask something…"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="chat-send-btn">
          <i className="bx bx-send" />
        </button>
      </form>
    </div>
  );
};
