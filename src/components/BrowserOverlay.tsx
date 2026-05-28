import React, { useEffect, useMemo, useRef, useState } from "react";
import type { BrowserOpenRequest, ChatAttachment, ExternalChatPrompt } from "../types/browser";

type BrowserMode = "app" | "web";
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
  onSendToChat: (prompt: Omit<ExternalChatPrompt, "id">) => void;
}

const DEVICE_PRESETS = [
  { key: "responsive", label: "Responsive", width: 0, height: 0 },
  { key: "desktop", label: "Desktop", width: 1440, height: 900 },
  { key: "macos", label: "macOS", width: 1280, height: 832 },
  { key: "windows", label: "Windows", width: 1366, height: 768 },
  { key: "linux", label: "Linux", width: 1366, height: 768 },
  { key: "iphone", label: "iPhone", width: 390, height: 844 },
  { key: "android", label: "Android", width: 412, height: 915 },
  { key: "tablet", label: "Tablet", width: 820, height: 1180 },
];

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^(https?:|file:|data:|about:)/i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/.*)?$/i.test(value)) {
    return `http://${value.replace(/^0\.0\.0\.0/i, "127.0.0.1")}`;
  }
  if (/\s/.test(value) || (!value.includes(".") && !value.includes(":"))) {
    return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  }
  return `https://${value}`;
}

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/i.test(url);
}

function compactUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

  const [mode, setMode] = useState<BrowserMode>("app");
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
  const [nativeHint, setNativeHint] = useState("");

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
    if (request.mode) setMode(request.mode);
    if (request.device && DEVICE_PRESETS.some(item => item.key === request.device)) {
      setDevice(request.device);
    }
    if (request.url) {
      const normalized = normalizeUrl(request.url);
      setMode(request.mode || (isLocalUrl(normalized) ? "app" : "web"));
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

  function navigateTo(raw: string, navMode: "push" | "replace" = "push") {
    const next = normalizeUrl(raw);
    if (!next) return;
    setAddress(next);
    setCurrentUrl(next);
    setLoading(true);
    setNativeHint("");
    setSelection(null);
    setDraft(null);
    setFrameTitle("");
    if (navMode === "replace" || historyIndex < 0) {
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

  async function openNativeWindow(raw = currentUrl || address) {
    const url = normalizeUrl(raw);
    if (!url) return;
    setNativeHint("Opening native webview...");
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const label = `integraded-browser-${Date.now()}`;
      const webview = new WebviewWindow(label, {
        url,
        title: `Integraded Browser - ${compactUrl(url)}`,
        width: 1280,
        height: 820,
        center: true,
        resizable: true,
        decorations: true,
        focus: true,
        incognito: mode === "app",
      });
      await webview.once("tauri://created", () => setNativeHint("Opened in native webview"));
      await webview.once("tauri://error", () => setNativeHint("Native webview could not be opened"));
    } catch {
      setNativeHint("Native webview is available only inside the Tauri app");
    }
    setTimeout(() => setNativeHint(""), 2600);
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
    setNote("");
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

  function makeSelectionAttachment(): ChatAttachment | undefined {
    if (!selection) return undefined;
    const viewport = viewportRef.current?.getBoundingClientRect();
    const width = Math.round(viewport?.width || preset.width || 0);
    const height = Math.round(viewport?.height || preset.height || 0);
    const scale = 0.35;
    const canvasWidth = Math.max(360, Math.min(760, Math.round(width * scale)));
    const canvasHeight = Math.max(220, Math.min(520, Math.round(height * scale)));
    const sx = Math.round(selection.x * (canvasWidth / Math.max(width, 1)));
    const sy = Math.round(selection.y * (canvasHeight / Math.max(height, 1)));
    const sw = Math.max(8, Math.round(selection.width * (canvasWidth / Math.max(width, 1))));
    const sh = Math.max(8, Math.round(selection.height * (canvasHeight / Math.max(height, 1))));
    const title = escapeXml(frameTitle || compactUrl(currentUrl) || "Browser selection");
    const url = escapeXml(currentUrl || "not opened");
    const bounds = escapeXml(`${selection.kind} x=${Math.round(selection.x)} y=${Math.round(selection.y)} w=${Math.round(selection.width)} h=${Math.round(selection.height)} viewport=${width}x${height}`);
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">`,
      `<rect width="100%" height="100%" fill="#111"/>`,
      `<rect x="10" y="10" width="${canvasWidth - 20}" height="${canvasHeight - 20}" rx="8" fill="#f8f8f8"/>`,
      `<text x="24" y="34" font-family="monospace" font-size="13" fill="#222">${title}</text>`,
      `<text x="24" y="54" font-family="monospace" font-size="10" fill="#666">${url}</text>`,
      `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" fill="rgba(251,191,36,0.22)" stroke="#f59e0b" stroke-width="3"/>`,
      `<text x="24" y="${canvasHeight - 28}" font-family="monospace" font-size="10" fill="#333">${bounds}</text>`,
      `</svg>`,
    ].join("");
    return {
      id: `sel-${Date.now()}`,
      type: "browser-selection",
      name: "browser-selection.svg",
      mime: "image/svg+xml",
      url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      detail: `${selection.kind} selection on ${currentUrl || "browser"} (${bounds})`,
    };
  }

  function buildChatPayload(): Omit<ExternalChatPrompt, "id"> {
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
    const attachment = makeSelectionAttachment();

    return {
      text: [
        "Browser feedback from the integrated browser.",
        `Mode: ${mode === "app" ? "sandboxed app preview" : "web browsing"}`,
        `URL: ${currentUrl || "not opened"}`,
        `Title: ${frameTitle || "unknown"}`,
        `Device preset: ${mode === "app" ? `${preset.label}${width && height ? ` (${width}x${height})` : ""}` : "browser window"}`,
        selected,
        "",
        `User request: ${note.trim() || "Inspect this view and propose the right fix."}`,
        "",
        "Use project files, terminal transcripts, and tool calls. Split the work between available CLI agents when it makes sense. If a mentioned file or selected region matters, make the receiving agent inspect it before editing.",
      ].join("\n"),
      attachments: attachment ? [attachment] : undefined,
    };
  }

  function sendToChat() {
    const payload = buildChatPayload();
    onSendToChat(payload);
    setSentHint("Sent to chat");
    setTimeout(() => setSentHint(""), 1800);
  }

  function popoverStyle(): React.CSSProperties {
    if (!selection) return {};
    const viewport = viewportRef.current?.getBoundingClientRect();
    const vw = viewport?.width || 360;
    const vh = viewport?.height || 260;
    const left = Math.min(Math.max(10, selection.x + selection.width + 10), Math.max(10, vw - 304));
    const top = Math.min(Math.max(10, selection.y), Math.max(10, vh - 190));
    return { left, top };
  }

  const selectionBox = draft || selection;
  const hasUrl = Boolean(currentUrl);
  const sandboxPolicy = mode === "app"
    ? "allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock allow-presentation"
    : undefined;

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
          <div className="browser-nav" aria-label="Navigation">
            <button type="button" className="browser-icon-btn" disabled={historyIndex <= 0} onClick={() => go(-1)} title="Back">
              <i className="bx bx-chevron-left" />
            </button>
            <button type="button" className="browser-icon-btn" disabled={historyIndex >= history.length - 1} onClick={() => go(1)} title="Forward">
              <i className="bx bx-chevron-right" />
            </button>
            <button type="button" className="browser-icon-btn" disabled={!currentUrl} onClick={reload} title="Reload">
              <i className={`bx bx-refresh ${loading ? "spin" : ""}`} />
            </button>
          </div>

          <form className="browser-address" onSubmit={event => { event.preventDefault(); navigateTo(address); }}>
            <i className={`bx ${mode === "app" ? "bx-shield-quarter" : "bx-search-alt-2"}`} />
            <input
              value={address}
              onChange={event => setAddress(event.target.value)}
              placeholder={mode === "app" ? "localhost:3000 or app URL" : "Search or enter a website"}
            />
            <button type="submit" title="Open">
              <i className="bx bx-right-arrow-alt" />
            </button>
          </form>

          <div className="browser-mode-switch" aria-label="Browser mode">
            <button type="button" className={mode === "app" ? "active" : ""} onClick={() => setMode("app")} title="Sandboxed app preview">
              App
            </button>
            <button type="button" className={mode === "web" ? "active" : ""} onClick={() => setMode("web")} title="Web browsing">
              Web
            </button>
          </div>

          <div className="browser-tool-group" aria-label="Browser tools">
            <button type="button" className={`browser-tool-btn ${tool === "browse" ? "active" : ""}`} onClick={() => setTool("browse")} title="Interact with page">
              Browse
            </button>
            <button type="button" className={`browser-tool-btn ${tool === "point" ? "active" : ""}`} onClick={() => setTool("point")} title="Select element">
              Pick
            </button>
            <button type="button" className={`browser-tool-btn ${tool === "region" ? "active" : ""}`} onClick={() => setTool("region")} title="Select region">
              Area
            </button>
          </div>

          {mode === "web" ? (
            <button type="button" className="browser-native-btn" disabled={!currentUrl && !address.trim()} onClick={() => openNativeWindow()} title="Open in native Tauri webview for sites that block iframe embedding">
              Native
            </button>
          ) : (
            <div className="browser-device-strip">
              {DEVICE_PRESETS.map(item => (
                <button
                  key={item.key}
                  type="button"
                  className={`browser-device-btn ${device === item.key ? "active" : ""}`}
                  onClick={() => setDevice(item.key)}
                  title={item.label}
                >
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {(cleanedSuggestions.length > 0 || sentHint || nativeHint) && (
          <div className="browser-suggestion-row">
            {cleanedSuggestions.map(url => (
              <button key={url} type="button" onClick={() => { setMode("app"); navigateTo(url); }}>
                <i className="bx bx-link-external" />
                {compactUrl(url)}
              </button>
            ))}
            {sentHint && <span className="browser-sent-hint">{sentHint}</span>}
            {nativeHint && <span className="browser-sent-hint">{nativeHint}</span>}
          </div>
        )}

        <div className={`browser-stage mode-${mode}`}>
          <div
            ref={viewportRef}
            className={`browser-viewport ${mode === "app" && preset.width ? "device-fixed" : "device-fluid"} tool-${tool}`}
            style={{
              ["--browser-device-width" as string]: mode === "app" && preset.width ? `${preset.width}px` : "100%",
              ["--browser-device-height" as string]: mode === "app" && preset.height ? `${preset.height}px` : "100%",
            } as React.CSSProperties}
          >
            {hasUrl ? (
              <iframe
                key={`${currentUrl}-${frameKey}-${mode}`}
                ref={iframeRef}
                className="browser-frame"
                src={currentUrl}
                title="Integrated browser preview"
                sandbox={sandboxPolicy}
                allow="clipboard-read; clipboard-write; fullscreen; geolocation; camera; microphone"
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
                <i className={`bx ${mode === "app" ? "bx-shield-quarter" : "bx-globe"}`} />
                <span className="browser-start-title">{mode === "app" ? "Open a sandboxed app preview" : "Open a website"}</span>
                <span className="browser-start-sub">
                  {mode === "app"
                    ? "Use a detected localhost URL from your dev server and choose the device viewport you want to simulate."
                    : "Search or open a URL. If a site blocks embedding, use Native to open it in a Tauri webview."}
                </span>
                <form className="browser-start-form" onSubmit={event => { event.preventDefault(); navigateTo(address); }}>
                  <input value={address} onChange={event => setAddress(event.target.value)} placeholder={mode === "app" ? "localhost:3000" : "google.com or search"} />
                  <button type="submit"><i className="bx bx-right-arrow-alt" /></button>
                </form>
              </div>
            )}

            {mode === "web" && hasUrl && (
              <button type="button" className="browser-native-fallback" onClick={() => openNativeWindow()}>
                Site blocked here? Open Native
              </button>
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

            {selection && (
              <div className="browser-selection-popover" style={popoverStyle()} onMouseDown={event => event.stopPropagation()}>
                <div className="browser-popover-head">
                  <span>{selection.kind === "element" ? "Element" : "Selection"}</span>
                  <button type="button" onClick={() => setSelection(null)} title="Clear selection">
                    <i className="bx bx-x" />
                  </button>
                </div>
                <div className="browser-popover-meta">
                  {Math.round(selection.width)}x{Math.round(selection.height)}
                  {selection.elementInfo ? ` - ${selection.elementInfo}` : ""}
                </div>
                <textarea
                  value={note}
                  onChange={event => setNote(event.target.value)}
                  placeholder="Describe what should change here..."
                  autoFocus
                />
                <div className="browser-popover-actions">
                  <button type="button" className="browser-popover-ghost" onClick={() => setSelection(null)}>Clear</button>
                  <button type="button" className="browser-send-chat" onClick={sendToChat}>
                    <i className="bx bx-send" />
                    Send
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
