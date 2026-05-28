import React, { useEffect, useMemo, useRef, useState } from "react";
import type { BrowserOpenRequest } from "../types/browser";

type BrowserTool = "browse" | "point" | "region";

interface BrowserSelection {
  kind: "element" | "region";
  x: number;
  y: number;
  width: number;
  height: number;
  elementInfo?: string;
}

interface BrowserOverlayProps {
  open: boolean;
  request?: BrowserOpenRequest | null;
  suggestedUrls?: string[];
  workspaceName?: string;
  onClose: () => void;
  onSendToChat: (text: string) => void;
}

const DEVICE_PRESETS = [
  { key: "responsive", label: "Responsive", icon: "bx-expand", width: 0, height: 0 },
  { key: "desktop", label: "Desktop", icon: "bx-desktop", width: 1440, height: 900 },
  { key: "macos", label: "macOS", icon: "bx-laptop", width: 1280, height: 832 },
  { key: "windows", label: "Windows", icon: "bx-window", width: 1366, height: 768 },
  { key: "linux", label: "Linux", icon: "bx-terminal", width: 1366, height: 768 },
  { key: "iphone", label: "iPhone", icon: "bx-mobile", width: 390, height: 844 },
  { key: "android", label: "Android", icon: "bx-mobile-alt", width: 412, height: 915 },
  { key: "tablet", label: "Tablet", icon: "bx-tablet", width: 820, height: 1180 },
];

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^(https?:|file:|data:|about:)/i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/.*)?$/i.test(value)) {
    return `http://${value.replace(/^0\.0\.0\.0/i, "127.0.0.1")}`;
  }
  return `https://${value}`;
}

function compactUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export const BrowserOverlay: React.FC<BrowserOverlayProps> = ({
  open,
  request,
  suggestedUrls = [],
  workspaceName = "Workspace",
  onClose,
  onSendToChat,
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const handledRequestRef = useRef<string | null>(null);

  const [address, setAddress] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [device, setDevice] = useState("responsive");
  const [tool, setTool] = useState<BrowserTool>("browse");
  const [selection, setSelection] = useState<BrowserSelection | null>(null);
  const [draft, setDraft] = useState<BrowserSelection | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [note, setNote] = useState("");
  const [sentHint, setSentHint] = useState("");
  const [frameTitle, setFrameTitle] = useState("");

  const preset = useMemo(
    () => DEVICE_PRESETS.find(item => item.key === device) || DEVICE_PRESETS[0],
    [device],
  );

  const cleanedSuggestions = useMemo(() => {
    const seen = new Set<string>();
    for (const url of suggestedUrls) {
      const normalized = normalizeUrl(url);
      if (normalized) seen.add(normalized);
    }
    return Array.from(seen).slice(0, 6);
  }, [suggestedUrls]);

  useEffect(() => {
    if (!open || !request || handledRequestRef.current === request.id) return;
    handledRequestRef.current = request.id;
    if (request.device && DEVICE_PRESETS.some(item => item.key === request.device)) {
      setDevice(request.device);
    }
    if (request.url) {
      navigateTo(request.url);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request?.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (tool !== "browse" || selection) {
          setTool("browse");
          setSelection(null);
          setDraft(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, selection, tool]);

  if (!open) return null;

  function navigateTo(raw: string, mode: "push" | "replace" = "push") {
    const next = normalizeUrl(raw);
    if (!next) return;
    setAddress(next);
    setCurrentUrl(next);
    setLoading(true);
    setSelection(null);
    setDraft(null);
    setFrameTitle("");
    if (mode === "replace" || historyIndex < 0) {
      setHistory([next]);
      setHistoryIndex(0);
    } else {
      setHistory(prev => {
        const base = prev.slice(0, historyIndex + 1);
        if (base[base.length - 1] !== next) base.push(next);
        setHistoryIndex(base.length - 1);
        return base;
      });
    }
  }

  function go(delta: number) {
    const nextIndex = historyIndex + delta;
    if (nextIndex < 0 || nextIndex >= history.length) return;
    const next = history[nextIndex];
    setHistoryIndex(nextIndex);
    setAddress(next);
    setCurrentUrl(next);
    setLoading(true);
    setSelection(null);
    setDraft(null);
  }

  function reload() {
    if (!currentUrl) return;
    setLoading(true);
    setFrameKey(key => key + 1);
  }

  function readElementInfo(x: number, y: number): string | undefined {
    try {
      const doc = iframeRef.current?.contentDocument;
      const element = doc?.elementFromPoint(x, y) as HTMLElement | null;
      if (!element) return undefined;
      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : "";
      const classes = typeof element.className === "string"
        ? element.className.split(/\s+/).filter(Boolean).slice(0, 4).map(cls => `.${cls}`).join("")
        : "";
      const aria = element.getAttribute("aria-label");
      const text = (aria || element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      return `${tag}${id}${classes}${text ? ` | "${text}"` : ""}`;
    } catch {
      return undefined;
    }
  }

  function pointFromEvent(event: React.MouseEvent<HTMLDivElement>) {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
  }

  function beginSelection(event: React.MouseEvent<HTMLDivElement>) {
    if (tool === "browse") return;
    event.preventDefault();
    const point = pointFromEvent(event);
    setDragStart(point);
    const next: BrowserSelection = {
      kind: tool === "point" ? "element" : "region",
      x: point.x,
      y: point.y,
      width: tool === "point" ? 14 : 0,
      height: tool === "point" ? 14 : 0,
    };
    setDraft(next);
  }

  function updateSelection(event: React.MouseEvent<HTMLDivElement>) {
    if (!dragStart || tool === "browse") return;
    const point = pointFromEvent(event);
    const x = Math.min(dragStart.x, point.x);
    const y = Math.min(dragStart.y, point.y);
    const width = Math.abs(point.x - dragStart.x);
    const height = Math.abs(point.y - dragStart.y);
    setDraft({
      kind: width > 6 || height > 6 ? "region" : "element",
      x,
      y,
      width: Math.max(tool === "point" ? 14 : 1, width),
      height: Math.max(tool === "point" ? 14 : 1, height),
    });
  }

  function finishSelection(event: React.MouseEvent<HTMLDivElement>) {
    if (!dragStart || tool === "browse") return;
    const point = pointFromEvent(event);
    const width = Math.abs(point.x - dragStart.x);
    const height = Math.abs(point.y - dragStart.y);
    const isRegion = tool === "region" || width > 8 || height > 8;
    const x = isRegion ? Math.min(dragStart.x, point.x) : Math.max(0, point.x - 7);
    const y = isRegion ? Math.min(dragStart.y, point.y) : Math.max(0, point.y - 7);
    const next: BrowserSelection = {
      kind: isRegion ? "region" : "element",
      x,
      y,
      width: isRegion ? Math.max(1, width) : 14,
      height: isRegion ? Math.max(1, height) : 14,
      elementInfo: !isRegion ? readElementInfo(point.x, point.y) : undefined,
    };
    setSelection(next);
    setDraft(null);
    setDragStart(null);
  }

  function buildChatPrompt() {
    const viewport = viewportRef.current?.getBoundingClientRect();
    const width = Math.round(viewport?.width || preset.width || 0);
    const height = Math.round(viewport?.height || preset.height || 0);
    const selected = selection
      ? [
          `Selection: ${selection.kind}`,
          `Bounds: x=${Math.round(selection.x)}, y=${Math.round(selection.y)}, w=${Math.round(selection.width)}, h=${Math.round(selection.height)} in ${width}x${height} viewport`,
          selection.elementInfo ? `Element: ${selection.elementInfo}` : "Element: unavailable, likely cross-origin iframe",
        ].join("\n")
      : "Selection: none";

    return [
      "Browser feedback from the integrated web browser.",
      `URL: ${currentUrl || "not opened"}`,
      `Title: ${frameTitle || "unknown"}`,
      `Device preset: ${preset.label}${width && height ? ` (${width}x${height})` : ""}`,
      selected,
      "",
      `User request: ${note.trim() || "Inspect this view and propose the right fix."}`,
      "",
      "Use the terminal transcript, project files, and tool calls to split the fix between CLI agents. If this needs more detail, ask me before changing behavior.",
    ].join("\n");
  }

  function sendToChat() {
    const prompt = buildChatPrompt();
    onSendToChat(prompt);
    setSentHint("Sent to chat");
    setTimeout(() => setSentHint(""), 1800);
  }

  const selectionBox = draft || selection;
  const hasUrl = Boolean(currentUrl);

  return (
    <div className="browser-overlay" role="dialog" aria-modal="true" aria-label="Integrated browser">
      <div className="browser-window">
        <div className="browser-titlebar">
          <div className="browser-traffic">
            <button type="button" className="browser-dot close" onClick={onClose} title="Close browser" />
            <span className="browser-dot minimize" />
            <span className="browser-dot maximize" />
          </div>
          <div className="browser-tab">
            <i className="bx bx-globe" />
            <span>{frameTitle || request?.label || workspaceName}</span>
          </div>
          <button type="button" className="browser-icon-btn" onClick={onClose} title="Close">
            <i className="bx bx-x" />
          </button>
        </div>

        <div className="browser-toolbar">
          <div className="browser-nav">
            <button type="button" className="browser-icon-btn" disabled={historyIndex <= 0} onClick={() => go(-1)} title="Back">
              <i className="bx bx-left-arrow-alt" />
            </button>
            <button type="button" className="browser-icon-btn" disabled={historyIndex >= history.length - 1} onClick={() => go(1)} title="Forward">
              <i className="bx bx-right-arrow-alt" />
            </button>
            <button type="button" className="browser-icon-btn" disabled={!currentUrl} onClick={reload} title="Reload">
              <i className={`bx bx-refresh ${loading ? "spin" : ""}`} />
            </button>
          </div>

          <form className="browser-address" onSubmit={event => { event.preventDefault(); navigateTo(address); }}>
            <i className="bx bx-lock-alt" />
            <input
              value={address}
              onChange={event => setAddress(event.target.value)}
              placeholder="Search or enter URL, e.g. localhost:3000"
            />
            <button type="submit" title="Open">
              <i className="bx bx-right-arrow-alt" />
            </button>
          </form>

          <div className="browser-tool-group" aria-label="Browser tools">
            <button type="button" className={`browser-tool-btn ${tool === "browse" ? "active" : ""}`} onClick={() => setTool("browse")} title="Browse mode">
              <i className="bx bx-pointer" />
            </button>
            <button type="button" className={`browser-tool-btn ${tool === "point" ? "active" : ""}`} onClick={() => setTool("point")} title="Select element">
              <i className="bx bx-crosshair" />
            </button>
            <button type="button" className={`browser-tool-btn ${tool === "region" ? "active" : ""}`} onClick={() => setTool("region")} title="Select region">
              <i className="bx bx-select-multiple" />
            </button>
          </div>

          <div className="browser-device-strip">
            {DEVICE_PRESETS.map(item => (
              <button
                key={item.key}
                type="button"
                className={`browser-device-btn ${device === item.key ? "active" : ""}`}
                onClick={() => setDevice(item.key)}
                title={item.label}
              >
                <i className={`bx ${item.icon}`} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>

        {(cleanedSuggestions.length > 0 || sentHint) && (
          <div className="browser-suggestion-row">
            {cleanedSuggestions.map(url => (
              <button key={url} type="button" onClick={() => navigateTo(url)}>
                <i className="bx bx-link-external" />
                {compactUrl(url)}
              </button>
            ))}
            {sentHint && <span className="browser-sent-hint">{sentHint}</span>}
          </div>
        )}

        <div className="browser-stage">
          <div
            ref={viewportRef}
            className={`browser-viewport ${preset.width ? "device-fixed" : "device-fluid"} tool-${tool}`}
            style={{
              ["--browser-device-width" as string]: preset.width ? `${preset.width}px` : "100%",
              ["--browser-device-height" as string]: preset.height ? `${preset.height}px` : "100%",
            } as React.CSSProperties}
          >
            {hasUrl ? (
              <iframe
                key={`${currentUrl}-${frameKey}`}
                ref={iframeRef}
                className="browser-frame"
                src={currentUrl}
                title="Integrated browser preview"
                allow="clipboard-read; clipboard-write; fullscreen"
                onLoad={() => {
                  setLoading(false);
                  try {
                    setFrameTitle(iframeRef.current?.contentDocument?.title || "");
                  } catch {
                    setFrameTitle(compactUrl(currentUrl));
                  }
                }}
              />
            ) : (
              <div className="browser-start-page">
                <i className="bx bx-globe" />
                <span className="browser-start-title">Open an app or website</span>
                <span className="browser-start-sub">Use a localhost URL from your dev server, or open any web page that allows embedding.</span>
                <form className="browser-start-form" onSubmit={event => { event.preventDefault(); navigateTo(address); }}>
                  <input value={address} onChange={event => setAddress(event.target.value)} placeholder="localhost:3000" />
                  <button type="submit"><i className="bx bx-right-arrow-alt" /></button>
                </form>
              </div>
            )}

            {tool !== "browse" && (
              <div
                className="browser-select-layer"
                onMouseDown={beginSelection}
                onMouseMove={updateSelection}
                onMouseUp={finishSelection}
                onMouseLeave={() => {
                  if (dragStart) {
                    setDraft(null);
                    setDragStart(null);
                  }
                }}
              >
                {!selectionBox && (
                  <div className="browser-select-hint">
                    {tool === "point" ? "Click an element to describe a change" : "Drag over the area you want to change"}
                  </div>
                )}
                {selectionBox && (
                  <div
                    className={`browser-selection-box ${selectionBox.kind}`}
                    style={{
                      left: selectionBox.x,
                      top: selectionBox.y,
                      width: selectionBox.width,
                      height: selectionBox.height,
                    }}
                  />
                )}
              </div>
            )}
          </div>

          <aside className="browser-inspector-panel">
            <div className="browser-inspector-head">
              <span>Selection</span>
              {selection && (
                <button type="button" onClick={() => setSelection(null)} title="Clear selection">
                  <i className="bx bx-x" />
                </button>
              )}
            </div>
            <div className="browser-inspector-meta">
              {selection ? (
                <>
                  <span>{selection.kind}</span>
                  <span>{Math.round(selection.width)}x{Math.round(selection.height)}</span>
                  {selection.elementInfo && <span>{selection.elementInfo}</span>}
                </>
              ) : (
                <span>Use the pointer or region tool to reference part of the page.</span>
              )}
            </div>
            <textarea
              value={note}
              onChange={event => setNote(event.target.value)}
              placeholder="Describe what should change, what looks broken, or what the chatbot should test..."
            />
            <button type="button" className="browser-send-chat" onClick={sendToChat} disabled={!hasUrl && !note.trim()}>
              <i className="bx bx-send" />
              Send to Chat
            </button>
          </aside>
        </div>
      </div>
    </div>
  );
};
