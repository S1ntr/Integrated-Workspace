import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

interface BrowserTab {
  id: string;
  label: string;
  url: string;
  kind: "project" | "web";
  external?: boolean;
}

interface BrowserOverlayProps {
  open: boolean;
  request?: BrowserOpenRequest | null;
  suggestedUrls?: string[];
  workspaceName?: string;
  onClose: () => void;
  onSendToChat: (prompt: Omit<ExternalChatPrompt, "id">) => void;
}

interface BrowserNewWindowEvent {
  source_label?: string;
  url?: string;
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
  const embeddedWebviewRef = useRef<string | null>(null);
  const embeddedWebviewUrlRef = useRef("");
  const embeddedWebviewLabelRef = useRef("");
  const embeddedWebviewRequestRef = useRef(0);

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
  const [browserHint, setBrowserHint] = useState("");
  const [embeddedBrowserError, setEmbeddedBrowserError] = useState("");
  const [embeddedBrowserReady, setEmbeddedBrowserReady] = useState(false);
  const [tabs, setTabs] = useState<BrowserTab[]>([
    { id: "project", label: "Current project", url: "", kind: "project" },
  ]);
  const [activeTabId, setActiveTabId] = useState("project");

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

  const activeTab = useMemo(
    () => tabs.find(tab => tab.id === activeTabId) || tabs[0],
    [activeTabId, tabs],
  );

  const currentProjectUrl = cleanedSuggestions[0] || "";

  function readViewportBounds() {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 2 || rect.height < 2) return null;
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
  }

  async function closeEmbeddedWebview(resetState = true) {
    const label = embeddedWebviewRef.current;
    embeddedWebviewRef.current = null;
    embeddedWebviewUrlRef.current = "";
    embeddedWebviewLabelRef.current = "";
    if (resetState) setEmbeddedBrowserReady(false);
    if (!label) return;
    try {
      await invoke("browser_close_webview", { label });
    } catch {
      // The webview may already be gone after a tab/window transition.
    }
  }

  async function syncEmbeddedWebviewBounds() {
    const label = embeddedWebviewRef.current;
    const bounds = readViewportBounds();
    if (!label || !bounds) return;
    try {
      await invoke("browser_set_webview_bounds", {
        label,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    } catch {
      setEmbeddedBrowserError("Embedded browser lost its layout. Reopen the tab to reset it.");
    }
  }

  async function openEmbeddedWebview(raw: string, targetTabId = activeTabId) {
    const url = normalizeUrl(raw);
    const bounds = readViewportBounds();
    if (!url || !bounds) return;

    const requestId = embeddedWebviewRequestRef.current + 1;
    embeddedWebviewRequestRef.current = requestId;
    setLoading(true);
    setEmbeddedBrowserReady(false);
    setEmbeddedBrowserError("");

    if (embeddedWebviewRef.current && embeddedWebviewUrlRef.current === url) {
      try {
        await syncEmbeddedWebviewBounds();
        await invoke("browser_show_webview", { label: embeddedWebviewRef.current });
        setEmbeddedBrowserReady(true);
        setLoading(false);
        return;
      } catch {
        await closeEmbeddedWebview();
      }
    } else {
      await closeEmbeddedWebview();
    }

    if (embeddedWebviewRequestRef.current !== requestId) return;

    try {
      const label = `integraded-browser-${targetTabId}-${Date.now()}`
        .replace(/[^a-zA-Z0-9\-/:_]/g, "-")
        .slice(0, 96);
      await invoke("browser_create_webview", {
        label,
        url,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
      if (embeddedWebviewRequestRef.current !== requestId) return;

      embeddedWebviewRef.current = label;
      embeddedWebviewUrlRef.current = url;
      embeddedWebviewLabelRef.current = label;
      setEmbeddedBrowserReady(true);
      setEmbeddedBrowserError("");
      setLoading(false);
      void syncEmbeddedWebviewBounds();
      void invoke("browser_show_webview", { label });
    } catch (error) {
      embeddedWebviewRef.current = null;
      embeddedWebviewUrlRef.current = "";
      embeddedWebviewLabelRef.current = "";
      setEmbeddedBrowserReady(false);
      setLoading(false);
      setEmbeddedBrowserError(error instanceof Error ? error.message : "Embedded browser could not be opened.");
    }
  }

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
      const kind = isLocalUrl(normalized) ? "project" : "web";
      navigateTo(request.url, "push", kind, kind === "project" ? "project" : undefined);
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

  useEffect(() => {
    if (open) return;
    void closeEmbeddedWebview();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    listen<BrowserNewWindowEvent>("browser-new-window", event => {
      const url = event.payload?.url;
      if (!url) return;
      const source = event.payload?.source_label || "";
      if (source && embeddedWebviewLabelRef.current && source !== embeddedWebviewLabelRef.current) return;
      openInNewTab(url);
    }).then(fn => {
      if (alive) unlisten = fn;
      else fn();
    }).catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleResize = () => {
      void syncEmbeddedWebviewBounds();
    };
    const node = viewportRef.current;
    const observer = node && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(handleResize)
      : null;
    if (node) observer?.observe(node);
    window.addEventListener("resize", handleResize);
    const timer = window.setTimeout(handleResize, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", handleResize);
      observer?.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, device, currentUrl, address, activeTabId]);

  useEffect(() => {
    return () => {
      void closeEmbeddedWebview(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!open) return null;

  function updateTabForNavigation(tabId: string, url: string, kind: BrowserTab["kind"], external: boolean) {
    const label = tabId === "project" && kind === "project" ? "Current project" : compactUrl(url);
    setTabs(prev => prev.map(tab => tab.id === tabId ? { ...tab, url, kind, external, label } : tab));
  }

  function ensureWebTabFor(url: string): string {
    if (activeTab?.kind !== "project") return activeTabId;
    const id = `web-${Date.now()}`;
    setTabs(prev => [...prev, { id, label: compactUrl(url), url, kind: "web", external: true }]);
    setActiveTabId(id);
    return id;
  }

  function commitHistory(next: string, navMode: "push" | "replace") {
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

  function navigateTo(raw: string, navMode: "push" | "replace" = "push", kindOverride?: BrowserTab["kind"], targetOverride?: string) {
    const next = normalizeUrl(raw);
    if (!next) return;
    const nextIsLocal = isLocalUrl(next);
    const nextKind: BrowserTab["kind"] = kindOverride || (nextIsLocal ? "project" : "web");
    const external = nextKind === "web" && !nextIsLocal;
    const targetTabId = targetOverride || (external ? ensureWebTabFor(next) : activeTabId);

    setAddress(next);
    setMode(nextKind === "project" ? "app" : "web");
    setBrowserHint("");
    setEmbeddedBrowserError("");
    setSelection(null);
    setDraft(null);
    updateTabForNavigation(targetTabId, next, nextKind, external);
    commitHistory(next, navMode);

    if (external) {
      setTool("browse");
      setCurrentUrl("");
      setFrameTitle(compactUrl(next));
      void openEmbeddedWebview(next, targetTabId);
    } else {
      void closeEmbeddedWebview();
      setCurrentUrl(next);
      setLoading(true);
      setFrameTitle("");
    }
  }

  function go(delta: number) {
    const nextIndex = historyIndex + delta;
    if (nextIndex < 0 || nextIndex >= history.length) return;
    const next = history[nextIndex];
    const external = !isLocalUrl(next);
    setHistoryIndex(nextIndex);
    setAddress(next);
    setMode(external ? "web" : "app");
    setSelection(null);
    setDraft(null);
    updateTabForNavigation(activeTabId, next, external ? "web" : "project", external);
    if (external) {
      setTool("browse");
      setCurrentUrl("");
      setFrameTitle(compactUrl(next));
      void openEmbeddedWebview(next);
    } else {
      void closeEmbeddedWebview();
      setCurrentUrl(next);
      setLoading(true);
      setFrameTitle("");
    }
  }

  function reload() {
    if (!currentUrl) {
      if (address && mode === "web") void openEmbeddedWebview(address);
      return;
    }
    setLoading(true);
    setFrameKey(key => key + 1);
  }

  function selectTab(tab: BrowserTab) {
    setActiveTabId(tab.id);
    setAddress(tab.url);
    setMode(tab.kind === "project" ? "app" : "web");
    setSelection(null);
    setDraft(null);
    setBrowserHint("");
    setEmbeddedBrowserError("");
    if (tab.url && !tab.external) {
      void closeEmbeddedWebview();
      setCurrentUrl(tab.url);
      setLoading(true);
      setFrameTitle("");
    } else {
      setTool("browse");
      setCurrentUrl("");
      setFrameTitle(tab.url ? compactUrl(tab.url) : "");
      if (tab.url) {
        void openEmbeddedWebview(tab.url, tab.id);
      } else {
        setLoading(false);
        void closeEmbeddedWebview();
      }
    }
  }

  function addWebTab() {
    const id = `web-${Date.now()}`;
    const tab = { id, label: "New tab", url: "", kind: "web" as const };
    setTabs(prev => [...prev, tab]);
    selectTab(tab);
  }

  function openInNewTab(raw: string) {
    const next = normalizeUrl(raw);
    if (!next) return;
    const nextIsLocal = isLocalUrl(next);
    const id = `web-${Date.now()}`;
    const tab: BrowserTab = {
      id,
      label: compactUrl(next),
      url: next,
      kind: nextIsLocal ? "project" : "web",
      external: !nextIsLocal,
    };
    setTabs(prev => [...prev, tab]);
    setActiveTabId(id);
    setAddress(next);
    setHistory([next]);
    setHistoryIndex(0);
    setSelection(null);
    setDraft(null);
    setBrowserHint("");
    setEmbeddedBrowserError("");
    if (nextIsLocal) {
      setMode("app");
      void closeEmbeddedWebview();
      setCurrentUrl(next);
      setLoading(true);
      setFrameTitle("");
    } else {
      setMode("web");
      setTool("browse");
      setCurrentUrl("");
      setFrameTitle(compactUrl(next));
      void openEmbeddedWebview(next, id);
    }
  }

  function closeTab(tabId: string, event: React.MouseEvent) {
    event.stopPropagation();
    if (tabId === "project" || tabs.length <= 1) return;
    const remaining = tabs.filter(tab => tab.id !== tabId);
    setTabs(remaining);
    if (activeTabId === tabId) selectTab(remaining[remaining.length - 1]);
  }

  function openCurrentProject() {
    if (!currentProjectUrl) {
      setBrowserHint("No localhost project URL detected yet. Start a dev server first.");
      setTimeout(() => setBrowserHint(""), 2600);
      return;
    }
    setActiveTabId("project");
    setMode("app");
    navigateTo(currentProjectUrl, "push", "project", "project");
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
    const activeUrl = currentUrl || address;
    const title = escapeXml(frameTitle || compactUrl(activeUrl) || "Browser selection");
    const url = escapeXml(activeUrl || "not opened");
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
      detail: `${selection.kind} selection on ${activeUrl || "browser"} (${bounds})`,
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
        `URL: ${currentUrl || address || "not opened"}`,
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
  const embeddedWebUrl = mode === "web" && !currentUrl && address ? address : "";
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
          <div className="browser-tabs-row" aria-label="Browser tabs">
            {tabs.map(tab => (
              <button
                key={tab.id}
                type="button"
                className={`browser-tab-pill ${tab.id === activeTabId ? "active" : ""}`}
                onClick={() => selectTab(tab)}
                title={tab.url || tab.label}
              >
                <i className={`bx ${tab.kind === "project" ? "bx-code-block" : "bx-globe"}`} />
                <span>{tab.id === activeTabId ? (frameTitle || tab.label || workspaceName) : tab.label}</span>
                {tab.id !== "project" && (
                  <span
                    className="browser-tab-close"
                    role="button"
                    aria-label="Close tab"
                    onClick={(event) => closeTab(tab.id, event)}
                  >
                    <i className="bx bx-x" />
                  </span>
                )}
              </button>
            ))}
            <button type="button" className="browser-tab-add" onClick={addWebTab} title="New tab">
              <i className="bx bx-plus" />
            </button>
          </div>
          <button type="button" className="browser-icon-btn" onClick={onClose} title="Close">
            <i className="bx bx-x" />
          </button>
        </div>

        <div className={`browser-toolbar mode-${mode}`}>
          <div className="browser-nav" aria-label="Navigation">
            <button type="button" className="browser-icon-btn" disabled={historyIndex <= 0} onClick={() => go(-1)} title="Back">
              <i className="bx bx-chevron-left" />
            </button>
            <button type="button" className="browser-icon-btn" disabled={historyIndex >= history.length - 1} onClick={() => go(1)} title="Forward">
              <i className="bx bx-chevron-right" />
            </button>
            <button type="button" className="browser-icon-btn" disabled={!currentUrl && !(mode === "web" && address)} onClick={reload} title="Reload">
              <i className={`bx bx-refresh ${loading ? "spin" : ""}`} />
            </button>
          </div>

          <form className="browser-address" onSubmit={event => { event.preventDefault(); navigateTo(address); }}>
            <i className={`bx ${mode === "app" ? "bx-shield-quarter" : "bx-search-alt-2"}`} />
            <input
              value={address}
              onChange={event => setAddress(event.target.value)}
              placeholder="Search, URL, or localhost"
            />
            <button type="submit" title="Open">
              <i className="bx bx-right-arrow-alt" />
            </button>
          </form>

          <button type="button" className="browser-current-project-btn" onClick={openCurrentProject} title="Open detected localhost project">
            <i className="bx bx-code-block" />
            <span>Current project</span>
          </button>

          <div className="browser-tool-group" aria-label="Browser tools">
            <button type="button" className={`browser-tool-btn ${tool === "browse" ? "active" : ""}`} onClick={() => setTool("browse")} title="Interact with page">
              <i className="bx bx-mouse" />
              <span>Browse</span>
            </button>
            <button type="button" className={`browser-tool-btn ${tool === "point" ? "active" : ""}`} disabled={mode === "web"} onClick={() => setTool("point")} title={mode === "web" ? "Selection tools are available for the current project preview" : "Select element"}>
              <i className="bx bx-target-lock" />
              <span>Pick</span>
            </button>
            <button type="button" className={`browser-tool-btn ${tool === "region" ? "active" : ""}`} disabled={mode === "web"} onClick={() => setTool("region")} title={mode === "web" ? "Selection tools are available for the current project preview" : "Select region"}>
              <i className="bx bx-crop" />
              <span>Area</span>
            </button>
          </div>

          {mode === "app" && (
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

        {(cleanedSuggestions.length > 0 || sentHint || browserHint) && (
          <div className="browser-suggestion-row">
            {currentProjectUrl && (
              <button type="button" className="browser-current-suggestion" onClick={openCurrentProject}>
                <i className="bx bx-code-block" />
                Current project
              </button>
            )}
            {cleanedSuggestions.map(url => (
              <button key={url} type="button" onClick={() => { setMode("app"); navigateTo(url, "push", "project", "project"); }}>
                <i className="bx bx-link-external" />
                {compactUrl(url)}
              </button>
            ))}
            {sentHint && <span className="browser-sent-hint">{sentHint}</span>}
            {browserHint && <span className="browser-sent-hint">{browserHint}</span>}
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
            ) : embeddedWebUrl ? (
              <div className={`browser-webview-host ${embeddedBrowserReady ? "ready" : ""}`}>
                {(loading || !embeddedBrowserReady) && !embeddedBrowserError && (
                  <div className="browser-webview-status">
                    <i className="bx bx-loader-alt spin" />
                    <span>Opening {compactUrl(embeddedWebUrl)}</span>
                  </div>
                )}
                {embeddedBrowserError && (
                  <div className="browser-webview-status error">
                    <i className="bx bx-error-circle" />
                    <span>{embeddedBrowserError}</span>
                    <button type="button" onClick={() => openEmbeddedWebview(embeddedWebUrl)}>
                      Retry
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="browser-start-page">
                <i className={`bx ${mode === "app" ? "bx-shield-quarter" : "bx-globe"}`} />
                <span className="browser-start-title">{mode === "app" ? "Open the current project" : "Open a browser tab"}</span>
                <span className="browser-start-sub">
                  {mode === "app"
                    ? "Use Current project to open the detected localhost URL from your dev server, then choose a device viewport."
                    : "Search or open a URL. Regular websites open inside this browser tab."}
                </span>
                <form className="browser-start-form" onSubmit={event => { event.preventDefault(); navigateTo(address); }}>
                  <input value={address} onChange={event => setAddress(event.target.value)} placeholder="google.com, search text, or localhost:3000" />
                  <button type="submit"><i className="bx bx-right-arrow-alt" /></button>
                </form>
                {mode === "app" && currentProjectUrl && (
                  <button type="button" className="browser-start-project" onClick={openCurrentProject}>
                    <i className="bx bx-code-block" />
                    Current project
                  </button>
                )}
              </div>
            )}

            {mode === "app" && tool !== "browse" && (
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
