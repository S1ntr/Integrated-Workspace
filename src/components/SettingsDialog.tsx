import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SkillsTab } from "./SkillsTab";

interface SettingsDialogProps {
  onClose: () => void;
}

interface AppConfig {
  provider: string;
  lmstudio_url: string;
  ollama_url: string;
  cloud_provider: string;
  active_model: string;
  streaming: boolean;
  thinking_preview: boolean;
  api_keys?: Record<string, string>;
}

// ── Provider validation defs ──
interface ProviderIdentity {
  id: string;
  name: string;
  iconUrl: string;
  short: string;
}

interface CloudProviderDef extends ProviderIdentity {
  baseUrl: string;
  keyPlaceholder: string;
  docsUrl: string;
  authScheme: "bearer" | "anthropic" | "gemini" | "ollama";
}

const CLOUD_PROVIDERS: CloudProviderDef[] = [
  {
    id: "openai", name: "OpenAI",
    iconUrl: "https://www.google.com/s2/favicons?domain=platform.openai.com&sz=64",
    short: "AI",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    keyPlaceholder: "sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
    authScheme: "bearer",
  },
  {
    id: "anthropic", name: "Anthropic",
    iconUrl: "https://www.google.com/s2/favicons?domain=anthropic.com&sz=64",
    short: "A",
    baseUrl: "https://api.anthropic.com/v1/messages",
    keyPlaceholder: "sk-ant-...",
    docsUrl: "https://console.anthropic.com/settings/keys",
    authScheme: "anthropic",
  },
  {
    id: "deepseek", name: "DeepSeek",
    iconUrl: "https://www.google.com/s2/favicons?domain=deepseek.com&sz=64",
    short: "D",
    baseUrl: "https://api.deepseek.com/chat/completions",
    keyPlaceholder: "sk-...",
    docsUrl: "https://platform.deepseek.com/api_keys",
    authScheme: "bearer",
  },
  {
    id: "mistral", name: "Mistral",
    iconUrl: "https://www.google.com/s2/favicons?domain=mistral.ai&sz=64",
    short: "M",
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    keyPlaceholder: "MISTRAL_...",
    docsUrl: "https://console.mistral.ai/api-keys",
    authScheme: "bearer",
  },
  {
    id: "google", name: "Google Gemini",
    iconUrl: "https://www.google.com/s2/favicons?domain=aistudio.google.com&sz=64",
    short: "G",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    keyPlaceholder: "AIza...",
    docsUrl: "https://aistudio.google.com/apikey",
    authScheme: "gemini",
  },
  {
    id: "grok", name: "Grok (xAI)",
    iconUrl: "https://www.google.com/s2/favicons?domain=x.ai&sz=64",
    short: "xAI",
    baseUrl: "https://api.x.ai/v1/chat/completions",
    keyPlaceholder: "xai-...",
    docsUrl: "https://console.x.ai",
    authScheme: "bearer",
  },
  {
    id: "together", name: "Together AI",
    iconUrl: "https://www.google.com/s2/favicons?domain=together.ai&sz=64",
    short: "T",
    baseUrl: "https://api.together.xyz/v1/chat/completions",
    keyPlaceholder: "tgp_...",
    docsUrl: "https://api.together.ai/settings/projects/~current/api-keys",
    authScheme: "bearer",
  },
  {
    id: "openrouter", name: "OpenRouter",
    iconUrl: "https://www.google.com/s2/favicons?domain=openrouter.ai&sz=64",
    short: "OR",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    keyPlaceholder: "sk-or-...",
    docsUrl: "https://openrouter.ai/settings/keys",
    authScheme: "bearer",
  },
  {
    id: "ollama_cloud", name: "Ollama Cloud",
    iconUrl: "https://www.google.com/s2/favicons?domain=ollama.com&sz=64",
    short: "OL",
    baseUrl: "https://ollama.com/api/chat",
    keyPlaceholder: "ollama_...",
    docsUrl: "https://ollama.com/settings/keys",
    authScheme: "ollama",
  },
];

const LOCAL_PROVIDERS: Record<"lmstudio" | "ollama", ProviderIdentity> = {
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    iconUrl: "https://www.google.com/s2/favicons?domain=lmstudio.ai&sz=64",
    short: "LM",
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    iconUrl: "https://www.google.com/s2/favicons?domain=ollama.com&sz=64",
    short: "OL",
  },
};

const ProviderLogo: React.FC<{ provider: ProviderIdentity }> = ({ provider }) => (
  <span className="stng-provider-logo" aria-hidden="true">
    <img
      src={provider.iconUrl}
      alt=""
      draggable={false}
      onError={event => {
        event.currentTarget.style.display = "none";
        event.currentTarget.parentElement?.classList.add("fallback");
      }}
    />
    <span>{provider.short}</span>
  </span>
);

// ── Toggle Switch ──
interface ToggleProps {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (val: boolean) => void;
}

const Toggle: React.FC<ToggleProps> = ({ label, desc, checked, onChange }) => (
  <div className="stng-toggle-row">
    <div className="stng-toggle-info">
      <span className="stng-toggle-label">{label}</span>
      <span className="stng-toggle-desc">{desc}</span>
    </div>
    <button
      type="button"
      className={`stng-toggle ${checked ? "on" : "off"}`}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
    >
      <span className="stng-toggle-track">
        <span className="stng-toggle-thumb" />
      </span>
    </button>
  </div>
);

type ThemeMode = "dark" | "light" | "auto" | "ocean" | "desert" | "void" | "forest" | "ember";

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  const KEYED = ["light","ocean","desert","void","forest","ember","dark"];
  if (KEYED.includes(mode)) root.setAttribute("data-theme", mode);
  else root.removeAttribute("data-theme");
  try { localStorage.setItem("__integraded_theme", mode); } catch {}
}

interface FontOption {
  id: string;
  label: string;
  value: string;
  url: string | null;
  category: string;
}

const FONT_OPTIONS: FontOption[] = [
  { id: "ibm-plex",      label: "IBM Plex Sans",     value: "'IBM Plex Sans', system-ui, sans-serif",     url: null,  category: "Default" },
  { id: "inter",         label: "Inter",              value: "'Inter', system-ui, sans-serif",              url: "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "geist-sans",    label: "Geist",              value: "'Geist Sans', system-ui, sans-serif",         url: "https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "space-grotesk", label: "Space Grotesk",      value: "'Space Grotesk', system-ui, sans-serif",      url: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "outfit",        label: "Outfit",             value: "'Outfit', system-ui, sans-serif",             url: "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "plus-jakarta",  label: "Plus Jakarta Sans",  value: "'Plus Jakarta Sans', sans-serif",             url: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "dm-sans",       label: "DM Sans",            value: "'DM Sans', sans-serif",                       url: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "manrope",       label: "Manrope",            value: "'Manrope', sans-serif",                       url: "https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "nunito",        label: "Nunito",             value: "'Nunito', sans-serif",                        url: "https://fonts.googleapis.com/css2?family=Nunito:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "sora",          label: "Sora",               value: "'Sora', sans-serif",                          url: "https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "figtree",       label: "Figtree",            value: "'Figtree', sans-serif",                       url: "https://fonts.googleapis.com/css2?family=Figtree:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "onest",         label: "Onest",              value: "'Onest', sans-serif",                         url: "https://fonts.googleapis.com/css2?family=Onest:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "lexend",        label: "Lexend",             value: "'Lexend', sans-serif",                        url: "https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "rubik",         label: "Rubik",              value: "'Rubik', sans-serif",                         url: "https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "work-sans",     label: "Work Sans",          value: "'Work Sans', sans-serif",                     url: "https://fonts.googleapis.com/css2?family=Work+Sans:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "karla",         label: "Karla",              value: "'Karla', sans-serif",                         url: "https://fonts.googleapis.com/css2?family=Karla:wght@300;400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "cabin",         label: "Cabin",              value: "'Cabin', sans-serif",                         url: "https://fonts.googleapis.com/css2?family=Cabin:wght@400;500;600;700&display=swap", category: "Sans-serif" },
  { id: "josefin",       label: "Josefin Sans",       value: "'Josefin Sans', sans-serif",                  url: "https://fonts.googleapis.com/css2?family=Josefin+Sans:wght@300;400;600;700&display=swap", category: "Display" },
  { id: "raleway",       label: "Raleway",            value: "'Raleway', sans-serif",                       url: "https://fonts.googleapis.com/css2?family=Raleway:wght@300;400;500;600;700&display=swap", category: "Display" },
  { id: "montserrat",    label: "Montserrat",         value: "'Montserrat', sans-serif",                    url: "https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap", category: "Display" },
];

const loadedFonts = new Set<string>();

function loadFont(font: FontOption) {
  if (!font.url || loadedFonts.has(font.id)) return;
  loadedFonts.add(font.id);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = font.url;
  document.head.appendChild(link);
}

function applyFont(fontId: string) {
  const font = FONT_OPTIONS.find(f => f.id === fontId) || FONT_OPTIONS[0];
  loadFont(font);
  document.documentElement.style.setProperty("--font-ui", font.value);
  try { localStorage.setItem("__integraded_font", fontId); } catch {}
}

// Pre-load saved font on module init
(function initFont() {
  try {
    const saved = localStorage.getItem("__integraded_font");
    if (saved) applyFont(saved);
  } catch {}
})()

const TABS = [
  { id: "keys",       label: "API Keys",   icon: "bx-key" },
  { id: "skills",     label: "Skills",     icon: "bx-extension" },
  { id: "behavior",   label: "Behavior",   icon: "bx-slider" },
  { id: "appearance", label: "Appearance", icon: "bx-palette" },
  { id: "security",   label: "Security",   icon: "bx-shield" },
];

export const SettingsDialog: React.FC<SettingsDialogProps> = ({ onClose }) => {
  const [activeTab, setActiveTab] = useState("keys");
  const [config, setConfig] = useState<AppConfig>({
    provider: "cloud",
    lmstudio_url: "http://localhost:1234",
    ollama_url: "http://localhost:11434",
    cloud_provider: "openai",
    active_model: "",
    streaming: true,
    thinking_preview: true,
    api_keys: {},
    chat_tool_mode: "ask",
  });

  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try { return (localStorage.getItem("__integraded_theme") as ThemeMode) || "dark"; } catch { return "dark"; }
  });

  const changeTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    applyTheme(mode);
  };

  const [fontId, setFontId] = useState<string>(() => {
    try { return localStorage.getItem("__integraded_font") || "ibm-plex"; } catch { return "ibm-plex"; }
  });

  const changeFont = (id: string) => {
    setFontId(id);
    applyFont(id);
  };

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [validating, setValidating] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<Record<string, "ok" | "err" | null>>({});
  const [testingLocal, setTestingLocal] = useState<string | null>(null);
  const [localStatus, setLocalStatus] = useState<Record<string, "ok" | "err" | null>>({});
  const [confirmClear, setConfirmClear] = useState(false);
  const [disabledProviders, setDisabledProviders] = useState<Set<string>>(new Set());

  const toggleProvider = async (provider: string) => {
    const isDisabled = disabledProviders.has(provider);
    const next = new Set(disabledProviders);
    if (isDisabled) next.delete(provider); else next.add(provider);
    setDisabledProviders(next);
    try {
      await invoke("set_provider_enabled", { provider, enabled: isDisabled });
      window.dispatchEvent(new CustomEvent("__integradedConfigUpdated"));
    } catch (err: any) {
      setError(`Failed to toggle provider: ${err}`);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const loaded = await invoke<AppConfig>("load_config");
        setConfig({
          provider: loaded.provider || "cloud",
          lmstudio_url: loaded.lmstudio_url || "http://localhost:1234",
          ollama_url: loaded.ollama_url || "http://localhost:11434",
          cloud_provider: loaded.cloud_provider || "openai",
          active_model: loaded.active_model || "",
          streaming: loaded.streaming ?? true,
          thinking_preview: loaded.thinking_preview ?? true,
          api_keys: loaded.api_keys || {},
          chat_tool_mode: (loaded as any).chat_tool_mode || "ask",
        } as any);
        Object.entries(loaded.api_keys || {}).forEach(([k, v]) => {
          if (v && v.length > 5) setKeyStatus(prev => ({ ...prev, [k]: "ok" }));
        });
        if (Array.isArray(loaded.disabled_providers)) {
          setDisabledProviders(new Set(loaded.disabled_providers as string[]));
        }
      } catch (err) {
        console.error("Failed to load config:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const updateKey = (provider: string, val: string) => {
    setConfig(prev => ({
      ...prev,
      api_keys: { ...prev.api_keys, [provider]: val },
    }));
    setKeyStatus(prev => ({ ...prev, [provider]: null }));
  };

  const deleteKey = async (provider: string) => {
    const newConfig = {
      ...config,
      api_keys: { ...config.api_keys, [provider]: "" },
    };
    setConfig(newConfig);
    setKeyStatus(prev => ({ ...prev, [provider]: null }));
    try {
      await invoke("save_config", { config: newConfig });
      window.dispatchEvent(new CustomEvent("__integradedConfigUpdated"));
    } catch (err: any) {
      setError(`Failed to remove key: ${err}`);
    }
  };

  const openProviderDocs = async (url: string) => {
    try {
      await openUrl(url);
    } catch (err) {
      console.warn("Failed to open provider docs via Tauri opener:", err);
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const validateKey = async (cloudProv: string, key: string): Promise<boolean> => {
    if (!key.trim() || key === "••••••••••••••••") { setError("Please enter an API key."); return false; }
    setValidating(cloudProv);
    setError(null);
    try {
      const provDef = CLOUD_PROVIDERS.find(d => d.id === cloudProv);
      if (!provDef) return true;

      const body = JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "ping" }], max_tokens: 1 });

      let url: string;
      let headers: string[][];

      if (provDef.authScheme === "anthropic") {
        url = provDef.baseUrl;
        headers = [["x-api-key", key], ["anthropic-version", "2023-06-01"], ["Content-Type", "application/json"]];
      } else if (provDef.authScheme === "gemini") {
        url = `${provDef.baseUrl}?key=${key}`;
        headers = [["Content-Type", "application/json"]];
      } else if (provDef.authScheme === "ollama") {
        url = provDef.baseUrl;
        headers = [["Authorization", `Bearer ${key}`], ["Content-Type", "application/json"]];
      } else {
        url = provDef.baseUrl;
        headers = [["Authorization", `Bearer ${key}`], ["Content-Type", "application/json"]];
      }

      const requestBody = provDef.authScheme === "ollama"
        ? JSON.stringify({ model: "gpt-oss:120b", messages: [{ role: "user", content: "ping" }], stream: false })
        : body;
      const res = await invoke<string>("curl_post", { url, body: requestBody, headers });
      const data = JSON.parse(res);
      if (data.error) throw new Error(data.error.message || "Invalid key");

      // ── Auto-save verified key to OS keychain immediately ──────────────────
      const newConfig = {
        ...config,
        api_keys: { ...config.api_keys, [cloudProv]: key },
      };
      await invoke("save_config", { config: newConfig });
      // Update local state: key is now stored (show masked placeholder)
      setConfig(prev => ({
        ...prev,
        api_keys: { ...prev.api_keys, [cloudProv]: "••••••••••••••••" },
      }));
      setKeyStatus(prev => ({ ...prev, [cloudProv]: "ok" }));
      // Notify ChatPanel so models from this provider appear immediately
      window.dispatchEvent(new CustomEvent("__integradedConfigUpdated"));
      return true;
    } catch (err: any) {
      setKeyStatus(prev => ({ ...prev, [cloudProv]: "err" }));
      setError(err.message || `Validation failed for ${cloudProv}`);
      return false;
    } finally {
      setValidating(null);
    }
  };

  const testLocalConnection = async (type: "lmstudio" | "ollama") => {
    const url = type === "lmstudio" ? config.lmstudio_url : config.ollama_url;
    if (!url.trim()) { setError("Please enter a URL."); return; }
    setTestingLocal(type);
    setError(null);
    try {
      const endpoint = type === "lmstudio" ? `${url.replace(/\/+$/, "")}/v1/models` : `${url.replace(/\/+$/, "")}/api/tags`;
      await invoke<string>("curl_get", { url: endpoint });
      setLocalStatus(prev => ({ ...prev, [type]: "ok" }));
    } catch (err: any) {
      setLocalStatus(prev => ({ ...prev, [type]: "err" }));
      setError(typeof err === "string" ? err : `Connection failed for ${type}`);
    } finally {
      setTestingLocal(null);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      await invoke("save_config", { config });
      setSuccess("Settings saved");
      window.dispatchEvent(new CustomEvent("__integradedConfigUpdated"));
      setTimeout(onClose, 800);
    } catch (err: any) {
      setError(err || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="dialog-overlay">
        <div className="stng-dialog">
          <div className="stng-loading">
            <i className="bx bx-loader-alt bx-spin" />
            <span>Loading configuration...</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="stng-dialog" onClick={e => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className="stng-header">
          <div className="stng-header-left">
            <div className="stng-header-icon"><i className="bx bx-cog" /></div>
            <div>
              <span className="stng-header-title">Settings</span>
              <span className="stng-header-sub">Integraded Workspace</span>
            </div>
          </div>
          <button className="stng-close" onClick={onClose}><i className="bx bx-x" /></button>
        </div>

        {/* ── Tabs ── */}
        <div className="stng-tabs">
          {TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              className={`stng-tab ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => { setActiveTab(tab.id); setError(null); setSuccess(null); }}
            >
              <i className={`bx ${tab.icon}`} />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* ── Body ── */}
        <div className="stng-body">
          {error && (
            <div className="stng-alert err">
              <i className="bx bx-error-circle" /><span>{error}</span>
            </div>
          )}
          {success && (
            <div className="stng-alert ok">
              <i className="bx bx-check-circle" /><span>{success}</span>
            </div>
          )}

          {/* ─── TAB: API Keys ─── */}
          {activeTab === "keys" && (
            <div className="stng-tab-content stng-tab-content-keys">
              <div className="stng-section">
                <div className="stng-section-header">
                  <i className="bx bx-key" />
                  <span>API Keys</span>
                </div>
                <div className="stng-section-body">
                  <p className="stng-section-desc">
                    Keys are encrypted at rest. Click <strong>Verify</strong> to test a key before saving.
                  </p>
                  {CLOUD_PROVIDERS.map(prov => {
                    const keyVal = (config.api_keys ?? {})[prov.id] || "";
                    const isSaved = keyVal === "••••••••••••••••";
                    const status = keyStatus[prov.id];

                    if (isSaved) {
                      const isDisabled = disabledProviders.has(prov.id);
                      // ── Saved state: key is in OS keychain ──────────────────
                      return (
                        <div key={prov.id} className={`stng-api-key-row stng-api-key-row-saved ${isDisabled ? "stng-api-key-row-disabled" : ""}`}>
                          <div className="stng-api-key-header">
                            <ProviderLogo provider={prov} />
                            <span>{prov.name}</span>
                            {isDisabled
                              ? <span className="stng-key-badge none">Disabled</span>
                              : <span className="stng-key-badge ok"><i className="bx bx-check" /> Active</span>
                            }
                          </div>
                          <div className="stng-api-key-input-row">
                            <div className="stng-key-saved-mask">
                              <i className="bx bx-lock-alt" />
                              <span>Stored in OS keychain</span>
                            </div>
                            {/* Enable / disable toggle */}
                            <button
                              type="button"
                              className={`stng-toggle ${isDisabled ? "off" : "on"}`}
                              role="switch"
                              aria-checked={!isDisabled}
                              onClick={() => toggleProvider(prov.id)}
                              title={isDisabled ? "Enable provider" : "Disable provider"}
                              style={{ flexShrink: 0 }}
                            >
                              <span className="stng-toggle-track"><span className="stng-toggle-thumb" /></span>
                            </button>
                            <button
                              type="button"
                              className="stng-btn stng-btn-danger stng-btn-sm"
                              title="Remove API key"
                              onClick={() => deleteKey(prov.id)}
                            >
                              <i className="bx bx-trash" />
                            </button>
                          </div>
                        </div>
                      );
                    }

                    // ── Unsaved state: show input + verify ──────────────────
                    return (
                      <div key={prov.id} className="stng-api-key-row">
                        <div className="stng-api-key-header">
                          <ProviderLogo provider={prov} />
                          <span>{prov.name}</span>
                          {status === "err" && <span className="stng-key-badge err"><i className="bx bx-x" /> Invalid</span>}
                          {!keyVal && !status && <span className="stng-key-badge none">Not set</span>}
                        </div>
                        <div className="stng-api-key-input-row">
                          <input
                            type="password"
                            className="stng-input"
                            value={keyVal}
                            onChange={e => updateKey(prov.id, e.target.value)}
                            placeholder={prov.keyPlaceholder}
                            onKeyDown={e => {
                              if (e.key === "Enter") {
                                const k = (config.api_keys ?? {})[prov.id] || "";
                                if (k.trim() && validating !== prov.id) validateKey(prov.id, k);
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="stng-btn stng-btn-ghost stng-btn-sm"
                            onClick={() => {
                              const k = (config.api_keys ?? {})[prov.id] || "";
                              if (k.trim()) validateKey(prov.id, k);
                            }}
                            disabled={!keyVal.trim() || validating === prov.id}
                          >
                            {validating === prov.id ? (
                              <i className="bx bx-loader-alt bx-spin" />
                            ) : (
                              "Verify & Save"
                            )}
                          </button>
                        </div>
                        <button type="button" className="stng-key-docs" onClick={() => openProviderDocs(prov.docsUrl)}>
                          <i className="bx bx-link-external" /> Get API key
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ── Local Providers ── */}
              <div className="stng-section">
                <div className="stng-section-header">
                  <i className="bx bx-desktop" />
                  <span>Local Providers</span>
                </div>
                <div className="stng-section-body">
                  <p className="stng-section-desc">
                    Configure custom endpoints for local servers. Changes take effect immediately.
                  </p>

                  {/* LM Studio */}
                  <div className="stng-api-key-row">
                    <div className="stng-api-key-header">
                      <ProviderLogo provider={LOCAL_PROVIDERS.lmstudio} />
                      <span>LM Studio</span>
                      {localStatus.lmstudio === "ok" && <span className="stng-key-badge ok">Online</span>}
                      {localStatus.lmstudio === "err" && <span className="stng-key-badge err">Offline</span>}
                    </div>
                    <div className="stng-api-key-input-row">
                      <input
                        type="text"
                        className="stng-input"
                        value={config.lmstudio_url}
                        onChange={e => setConfig(prev => ({ ...prev, lmstudio_url: e.target.value }))}
                        placeholder="http://localhost:1234"
                      />
                      <button
                        type="button"
                        className="stng-btn stng-btn-ghost stng-btn-sm"
                        onClick={() => testLocalConnection("lmstudio")}
                        disabled={testingLocal === "lmstudio"}
                      >
                        {testingLocal === "lmstudio" ? (
                          <i className="bx bx-loader-alt bx-spin" />
                        ) : (
                          "Test"
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Ollama */}
                  <div className="stng-api-key-row">
                    <div className="stng-api-key-header">
                      <ProviderLogo provider={LOCAL_PROVIDERS.ollama} />
                      <span>Ollama</span>
                      {localStatus.ollama === "ok" && <span className="stng-key-badge ok">Online</span>}
                      {localStatus.ollama === "err" && <span className="stng-key-badge err">Offline</span>}
                    </div>
                    <div className="stng-api-key-input-row">
                      <input
                        type="text"
                        className="stng-input"
                        value={config.ollama_url}
                        onChange={e => setConfig(prev => ({ ...prev, ollama_url: e.target.value }))}
                        placeholder="http://localhost:11434"
                      />
                      <button
                        type="button"
                        className="stng-btn stng-btn-ghost stng-btn-sm"
                        onClick={() => testLocalConnection("ollama")}
                        disabled={testingLocal === "ollama"}
                      >
                        {testingLocal === "ollama" ? (
                          <i className="bx bx-loader-alt bx-spin" />
                        ) : (
                          "Test"
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ─── TAB: Skills ─── */}
          {activeTab === "skills" && <SkillsTab />}

          {/* ─── TAB: Behavior ─── */}
          {activeTab === "behavior" && (
            <div className="stng-tab-content">
              <div className="stng-section">
                <div className="stng-section-header">
                  <i className="bx bx-slider" />
                  <span>Response Behavior</span>
                </div>
                <div className="stng-section-body">
                  <Toggle
                    label="Streaming responses"
                    desc="Show AI responses word-by-word as they generate instead of waiting for the full response"
                    checked={config.streaming}
                    onChange={v => setConfig(prev => ({ ...prev, streaming: v }))}
                  />
                  <Toggle
                    label="Thinking preview"
                    desc="Show the model thinking phase as a collapsible live preview while streaming"
                    checked={config.thinking_preview}
                    onChange={v => setConfig(prev => ({ ...prev, thinking_preview: v }))}
                  />
                </div>
              </div>

              <div className="stng-section">
                <div className="stng-section-header">
                  <i className="bx bx-trash" />
                  <span>Data Management</span>
                </div>
                <div className="stng-section-body">
                  <div className="stng-clear-history">
                    <p className="stng-section-desc">
                      Permanently delete all saved chats, current conversation, and cached messages.
                    </p>

                    <div className="stng-clear-confirm">
                      <i className="bx bx-error-circle" />
                      <span>This action cannot be undone.</span>
                    </div>

                    {confirmClear ? (
                      <div className="stng-clear-final">
                        <i className="bx bxs-trash-alt" />
                        <span>Are you sure? All chat history will be permanently deleted.</span>
                      </div>
                    ) : null}

                    <div className="stng-clear-actions">
                      {!confirmClear ? (
                        <button
                          type="button"
                          className="stng-btn stng-btn-danger"
                          onClick={() => setConfirmClear(true)}
                        >
                          <i className="bx bx-trash" />
                          Clear History
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="stng-btn stng-btn-ghost"
                            onClick={() => setConfirmClear(false)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="stng-btn stng-btn-danger-solid"
                            onClick={async () => {
                              try {
                                localStorage.removeItem("integraded_chat_current_msgs");
                                localStorage.removeItem("integraded_chat_histories");
                                localStorage.removeItem("integraded_chat_context_window");
                                localStorage.removeItem("integraded_tool_calls");
                                await invoke("clear_chat_history");
                                window.dispatchEvent(new CustomEvent("__integradedChatHistoryCleared"));
                                setConfirmClear(false);
                                setSuccess("Chat history cleared successfully.");
                                setError(null);
                              } catch (e) {
                                setError("Failed to clear chat history.");
                                setSuccess(null);
                              }
                            }}
                          >
                            <i className="bx bx-trash" />
                            Clear History
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ─── TAB: Appearance ─── */}
          {activeTab === "appearance" && (
            <div className="stng-tab-content">
              {/* Theme */}
              <div className="stng-section">
                <div className="stng-section-header">
                  <i className="bx bx-palette" />
                  <span>Theme</span>
                </div>
                <div className="stng-section-body">
                  <p className="stng-section-desc">
                    Choose how Integraded looks. Auto follows your system preference.
                  </p>
                  <div className="theme-picker">
                    {([
                      { value: "dark"   as const, label: "Dark",    icon: "bx-moon",      swatchClass: "theme-swatch-dark"   },
                      { value: "light"  as const, label: "Light",   icon: "bx-sun",       swatchClass: "theme-swatch-light"  },
                      { value: "auto"   as const, label: "Auto",    icon: "bx-adjust",    swatchClass: "theme-swatch-auto"   },
                      { value: "ocean"  as const, label: "Ocean",   icon: "bx-water",     swatchClass: "theme-swatch-ocean"  },
                      { value: "desert" as const, label: "Desert",  icon: "bx-landscape", swatchClass: "theme-swatch-desert" },
                      { value: "void"   as const, label: "Void",    icon: "bx-planet",    swatchClass: "theme-swatch-void"   },
                      { value: "forest" as const, label: "Forest",  icon: "bx-leaf",      swatchClass: "theme-swatch-forest" },
                      { value: "ember"  as const, label: "Ember",   icon: "bx-flame",     swatchClass: "theme-swatch-ember"  },
                    ]).map(t => (
                      <button
                        key={t.value}
                        type="button"
                        className={`theme-option ${themeMode === t.value ? "active" : ""}`}
                        onClick={() => changeTheme(t.value)}
                      >
                        <div className={`theme-swatch ${t.swatchClass}`} />
                        <span className="theme-label">
                          <i className={`bx ${t.icon}`} />
                          {t.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Font */}
              <div className="stng-section">
                <div className="stng-section-header">
                  <i className="bx bx-font" />
                  <span>UI Font</span>
                </div>
                <div className="stng-section-body">
                  <p className="stng-section-desc">
                    Choose the font used throughout the app interface. Applies immediately.
                  </p>
                  <div className="font-picker">
                    {FONT_OPTIONS.map(f => (
                      <button
                        key={f.id}
                        type="button"
                        className={`font-option ${fontId === f.id ? "active" : ""}`}
                        onClick={() => changeFont(f.id)}
                        onMouseEnter={() => loadFont(f)}
                        title={f.label}
                      >
                        <span className="font-option-name" style={{ fontFamily: f.value }}>{f.label}</span>
                        <span className="font-option-meta">{f.category}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

          {/* ── Security tab ── */}
          {activeTab === "security" && (
            <div className="stng-tab-content">
              <div className="stng-section">
                <div className="stng-section-header">
                  <i className="bx bx-shield" />
                  <span>Chat Tool Permissions</span>
                </div>
                <div className="stng-section-body">
                  <p className="stng-section-desc">
                    Controls whether the AI can run <code>read_file</code> and <code>exec_cmd</code> tools automatically or needs your approval first.
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "8px" }}>
                    {([
                      {
                        value: "ask",
                        label: "Accept Only (Recommended)",
                        desc: "AI tool calls (file reads, commands) show a confirmation prompt before executing. You approve or deny each one.",
                        icon: "bx-check-shield",
                      },
                      {
                        value: "bypass",
                        label: "Bypass Permissions",
                        desc: "All AI tool calls execute immediately without confirmation. Faster but less control.",
                        icon: "bx-bolt-circle",
                      },
                    ] as { value: string; label: string; desc: string; icon: string }[]).map(opt => (
                      <div
                        key={opt.value}
                        className={`stng-perm-option ${(config as any).chat_tool_mode === opt.value ? "active" : ""}`}
                        onClick={() => setConfig(prev => ({ ...prev, chat_tool_mode: opt.value } as any))}
                      >
                        <i className={`bx ${opt.icon} stng-perm-icon`} />
                        <div className="stng-perm-text">
                          <span className="stng-perm-label">{opt.label}</span>
                          <span className="stng-perm-desc">{opt.desc}</span>
                        </div>
                        <div className={`stng-perm-radio ${(config as any).chat_tool_mode === opt.value ? "checked" : ""}`} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="stng-footer">
          <button className="stng-btn stng-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="stng-btn stng-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? (
              <><i className="bx bx-loader-alt bx-spin" /> Saving...</>
            ) : (
              <><i className="bx bx-save" /> Save Changes</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
