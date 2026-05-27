import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

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
  api_keys?: Record<string, string>;
}

// ── Provider validation defs ──
interface CloudProviderDef {
  id: string;
  name: string;
  icon: string;
  baseUrl: string;
  keyPlaceholder: string;
  docsUrl: string;
  authScheme: "bearer" | "anthropic" | "gemini";
}

const CLOUD_PROVIDERS: CloudProviderDef[] = [
  {
    id: "openai", name: "OpenAI", icon: "bxl-openai",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    keyPlaceholder: "sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
    authScheme: "bearer",
  },
  {
    id: "anthropic", name: "Anthropic", icon: "bxl-tailwind-css",
    baseUrl: "https://api.anthropic.com/v1/messages",
    keyPlaceholder: "sk-ant-...",
    docsUrl: "https://console.anthropic.com/settings/keys",
    authScheme: "anthropic",
  },
  {
    id: "deepseek", name: "DeepSeek", icon: "bx-chip",
    baseUrl: "https://api.deepseek.com/chat/completions",
    keyPlaceholder: "sk-...",
    docsUrl: "https://platform.deepseek.com/api-keys",
    authScheme: "bearer",
  },
  {
    id: "mistral", name: "Mistral", icon: "bx-wind",
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    keyPlaceholder: "MISTRAL_...",
    docsUrl: "https://console.mistral.ai/api-keys",
    authScheme: "bearer",
  },
  {
    id: "google", name: "Google Gemini", icon: "bxl-google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    keyPlaceholder: "AIza...",
    docsUrl: "https://aistudio.google.com/apikey",
    authScheme: "gemini",
  },
  {
    id: "grok", name: "Grok (xAI)", icon: "bx-bolt",
    baseUrl: "https://api.x.ai/v1/chat/completions",
    keyPlaceholder: "xai-...",
    docsUrl: "https://console.x.ai",
    authScheme: "bearer",
  },
  {
    id: "together", name: "Together AI", icon: "bx-group",
    baseUrl: "https://api.together.xyz/v1/chat/completions",
    keyPlaceholder: "tgp_...",
    docsUrl: "https://api.together.xyz/settings/api-keys",
    authScheme: "bearer",
  },
  {
    id: "openrouter", name: "OpenRouter", icon: "bx-git-branch",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    keyPlaceholder: "sk-or-...",
    docsUrl: "https://openrouter.ai/keys",
    authScheme: "bearer",
  },
];

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

type ThemeMode = "dark" | "light" | "auto";

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === "dark")  root.setAttribute("data-theme", "dark");
  else if (mode === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
  try { localStorage.setItem("__integraded_theme", mode); } catch {}
}

const TABS = [
  { id: "keys",       label: "API Keys",   icon: "bx-key" },
  { id: "behavior",   label: "Behavior",   icon: "bx-slider" },
  { id: "appearance", label: "Appearance", icon: "bx-palette" },
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
    api_keys: {},
  });

  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try { return (localStorage.getItem("__integraded_theme") as ThemeMode) || "dark"; } catch { return "dark"; }
  });

  const changeTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    applyTheme(mode);
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
          api_keys: loaded.api_keys || {},
        });
        Object.entries(loaded.api_keys || {}).forEach(([k, v]) => {
          if (v && v.length > 5) setKeyStatus(prev => ({ ...prev, [k]: "ok" }));
        });
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

  const validateKey = async (cloudProv: string, key: string): Promise<boolean> => {
    if (!key.trim()) { setError("Please enter an API key."); return false; }
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
      } else {
        url = provDef.baseUrl;
        headers = [["Authorization", `Bearer ${key}`], ["Content-Type", "application/json"]];
      }

      const res = await invoke<string>("curl_post", { url, body, headers });
      const data = JSON.parse(res);
      if (data.error) throw new Error(data.error.message || "Invalid key");
      setKeyStatus(prev => ({ ...prev, [cloudProv]: "ok" }));
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
            <div className="stng-tab-content">
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
                    const status = keyStatus[prov.id];
                    return (
                      <div key={prov.id} className="stng-api-key-row">
                        <div className="stng-api-key-header">
                          <i className={`bx ${prov.icon}`} />
                          <span>{prov.name}</span>
                          {status === "ok" && <span className="stng-key-badge ok"><i className="bx bx-check" /></span>}
                          {status === "err" && <span className="stng-key-badge err"><i className="bx bx-x" /></span>}
                          {!keyVal && !status && <span className="stng-key-badge none">Not set</span>}
                        </div>
                        <div className="stng-api-key-input-row">
                          <input
                            type="password"
                            className="stng-input"
                            value={keyVal}
                            onChange={e => updateKey(prov.id, e.target.value)}
                            placeholder={prov.keyPlaceholder}
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
                              "Verify"
                            )}
                          </button>
                        </div>
                        <a className="stng-key-docs" href={prov.docsUrl} target="_blank" rel="noopener noreferrer">
                          <i className="bx bx-link-external" /> Get API key
                        </a>
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
                      <i className="bx bx-desktop" />
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
                      <i className="bx bx-data" />
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
                            onClick={() => {
                              try {
                                localStorage.removeItem("integraded_chat_current_msgs");
                                localStorage.removeItem("integraded_chat_histories");
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
                    <button
                      type="button"
                      className={`theme-option ${themeMode === "dark" ? "active" : ""}`}
                      onClick={() => changeTheme("dark")}
                    >
                      <i className="bx bx-moon" />
                      Dark
                    </button>
                    <button
                      type="button"
                      className={`theme-option ${themeMode === "light" ? "active" : ""}`}
                      onClick={() => changeTheme("light")}
                    >
                      <i className="bx bx-sun" />
                      Light
                    </button>
                    <button
                      type="button"
                      className={`theme-option ${themeMode === "auto" ? "active" : ""}`}
                      onClick={() => changeTheme("auto")}
                    >
                      <i className="bx bx-adjust" />
                      Auto
                    </button>
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
