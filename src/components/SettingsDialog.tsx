import React, { useState, useEffect, useRef } from "react";
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
  api_keys: Record<string, string>;
}

// ── Custom Segmented Select Dropdown for Settings ───────────────────────────
interface CustomSelectProps {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (val: string) => void;
}

const CustomSelect: React.FC<CustomSelectProps> = ({ label, value, options, onChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const clickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) window.addEventListener("mousedown", clickOutside);
    return () => window.removeEventListener("mousedown", clickOutside);
  }, [isOpen]);

  const activeOption = options.find((o) => o.value === value) || options[0];

  return (
    <div className="settings-field custom-select-container" ref={ref}>
      <label className="settings-label">{label}</label>
      <button
        type="button"
        className="custom-select-trigger"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{activeOption ? activeOption.label : value}</span>
        <i className={`bx bx-chevron-down ${isOpen ? "open" : ""}`} />
      </button>
      {isOpen && (
        <div className="custom-select-dropdown">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`custom-select-item ${opt.value === value ? "active" : ""}`}
              onClick={() => {
                onChange(opt.value);
                setIsOpen(false);
              }}
            >
              <span className="custom-select-item-text">{opt.label}</span>
              {opt.value === value && <i className="bx bx-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const SettingsDialog: React.FC<SettingsDialogProps> = ({ onClose }) => {
  const [activeTab, setActiveTab] = useState<"general" | "keys">("general");
  const [config, setConfig] = useState<AppConfig>({
    provider: "cloud",
    lmstudio_url: "http://localhost:1234",
    ollama_url: "http://localhost:11434",
    cloud_provider: "openai",
    active_model: "",
    api_keys: {},
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationSuccess, setValidationSuccess] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const loaded = await invoke<AppConfig>("load_config");
        // Ensure defaults are populated
        setConfig({
          provider: loaded.provider || "cloud",
          lmstudio_url: loaded.lmstudio_url || "http://localhost:1234",
          ollama_url: loaded.ollama_url || "http://localhost:11434",
          cloud_provider: loaded.cloud_provider || "openai",
          active_model: loaded.active_model || "",
          api_keys: loaded.api_keys || {},
        });
      } catch (err) {
        console.error("Failed to load settings config:", err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleChange = (field: keyof AppConfig, value: string) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
  };

  const handleKeyChange = (providerKey: string, value: string) => {
    setConfig((prev) => ({
      ...prev,
      api_keys: { ...prev.api_keys, [providerKey]: value },
    }));
  };

  // ── API Key Validation Helper ──────────────────────────────────────────────
  const validateApiKey = async (cloudProv: string, key: string): Promise<boolean> => {
    if (!key.trim() || key === "••••••••••••••••") return true; // empty or masked keys are skipped/valid

    try {
      if (cloudProv === "openai") {
        const body = JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        });
        const headers = [
          ["Authorization", `Bearer ${key}`],
          ["Content-Type", "application/json"],
        ];
        const resStr = await invoke<string>("curl_post", {
          url: "https://api.openai.com/v1/chat/completions",
          body,
          headers,
        });
        const res = JSON.parse(resStr);
        if (res.error) {
          throw new Error(res.error.message || "Invalid OpenAI API Key");
        }
        return true;
      } else if (cloudProv === "anthropic") {
        const body = JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        });
        const headers = [
          ["x-api-key", key],
          ["anthropic-version", "2023-06-01"],
          ["Content-Type", "application/json"],
        ];
        const resStr = await invoke<string>("curl_post", {
          url: "https://api.anthropic.com/v1/messages",
          body,
          headers,
        });
        const res = JSON.parse(resStr);
        if (res.error) {
          throw new Error(res.error.message || "Invalid Anthropic API Key");
        }
        return true;
      } else if (cloudProv === "deepseek") {
        const body = JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        });
        const headers = [
          ["Authorization", `Bearer ${key}`],
          ["Content-Type", "application/json"],
        ];
        const resStr = await invoke<string>("curl_post", {
          url: "https://api.deepseek.com/chat/completions",
          body,
          headers,
        });
        const res = JSON.parse(resStr);
        if (res.error) {
          throw new Error(res.error.message || "Invalid DeepSeek API Key");
        }
        return true;
      }
    } catch (err: any) {
      console.error("API Key validation error:", err);
      setValidationError(err.message || `Validation failed for ${cloudProv}`);
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    setSaving(true);
    setValidationError(null);
    setValidationSuccess(null);

    // Validate active provider keys if in cloud mode
    if (config.provider === "cloud") {
      const activeKey = config.api_keys[config.cloud_provider] || "";
      if (activeKey.trim()) {
        const isValid = await validateApiKey(config.cloud_provider, activeKey);
        if (!isValid) {
          setSaving(false);
          return;
        }
      }
    }

    try {
      await invoke("save_config", { config });
      setValidationSuccess("Settings saved successfully!");
      
      // Dispatch custom update event so ChatPanel re-polls
      window.dispatchEvent(new CustomEvent("__integradedConfigUpdated"));

      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err: any) {
      setValidationError(err || "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="dialog-overlay">
        <div className="dialog-box settings-dialog glassmorphic">
          <div className="settings-loading">
            <i className="bx bx-loader-alt bx-spin" />
            <span>Loading Workspace Config...</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-box settings-dialog glassmorphic" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <div className="settings-header-title">
            <i className="bx bx-cog" />
            <span className="dialog-title">Integraded Workspace Settings</span>
          </div>
          <button className="dialog-close" onClick={onClose}>
            <i className="bx bx-x" />
          </button>
        </div>

        {/* Tab Selection */}
        <div className="settings-tabs">
          <button
            className={`settings-tab-btn ${activeTab === "general" ? "active" : ""}`}
            onClick={() => setActiveTab("general")}
          >
            <i className="bx bx-slider" />
            General & Providers
          </button>
          <button
            className={`settings-tab-btn ${activeTab === "keys" ? "active" : ""}`}
            onClick={() => setActiveTab("keys")}
          >
            <i className="bx bx-key" />
            API Keys Security
          </button>
        </div>

        <div className="dialog-body settings-body">
          {validationError && (
            <div className="settings-alert error">
              <i className="bx bx-error-circle" />
              <span>{validationError}</span>
            </div>
          )}

          {validationSuccess && (
            <div className="settings-alert success">
              <i className="bx bx-check-circle" />
              <span>{validationSuccess}</span>
            </div>
          )}

          {activeTab === "general" ? (
            <div className="settings-section">
              {/* Custom Selector for Provider Selection */}
              <CustomSelect
                label="Primary AI Provider"
                value={config.provider}
                onChange={(val) => handleChange("provider", val)}
                options={[
                  { value: "cloud", label: "Cloud Provider (OpenAI, Anthropic, DeepSeek)" },
                  { value: "lmstudio", label: "LM Studio (Local Server)" },
                  { value: "ollama", label: "Ollama (Local Server)" },
                ]}
              />

              {/* Custom Selector for Cloud Coordinator */}
              {config.provider === "cloud" && (
                <CustomSelect
                  label="Cloud Coordinator"
                  value={config.cloud_provider}
                  onChange={(val) => handleChange("cloud_provider", val)}
                  options={[
                    { value: "openai", label: "OpenAI (GPT-4o, GPT-4o-Mini)" },
                    { value: "anthropic", label: "Anthropic (Claude 3.5 Sonnet)" },
                    { value: "deepseek", label: "DeepSeek (DeepSeek V3, R1)" },
                  ]}
                />
              )}

              {config.provider === "lmstudio" && (
                <div className="settings-field">
                  <label className="settings-label">LM Studio Base URL</label>
                  <input
                    type="text"
                    className="settings-input"
                    value={config.lmstudio_url}
                    onChange={(e) => handleChange("lmstudio_url", e.target.value)}
                    placeholder="http://localhost:1234"
                  />
                  <span className="settings-help">Custom endpoint base address for local LM Studio instances.</span>
                </div>
              )}

              {config.provider === "ollama" && (
                <div className="settings-field">
                  <label className="settings-label">Ollama Base URL</label>
                  <input
                    type="text"
                    className="settings-input"
                    value={config.ollama_url}
                    onChange={(e) => handleChange("ollama_url", e.target.value)}
                    placeholder="http://localhost:11434"
                  />
                  <span className="settings-help">Custom endpoint base address for local Ollama instances.</span>
                </div>
              )}
            </div>
          ) : (
            <div className="settings-section">
              <div className="settings-field">
                <label className="settings-label">OpenAI API Key</label>
                <div className="settings-password-input">
                  <input
                    type="password"
                    className="settings-input"
                    value={config.api_keys["openai"] || ""}
                    onChange={(e) => handleKeyChange("openai", e.target.value)}
                    placeholder="sk-proj-..."
                  />
                </div>
              </div>

              <div className="settings-field">
                <label className="settings-label">Anthropic API Key</label>
                <div className="settings-password-input">
                  <input
                    type="password"
                    className="settings-input"
                    value={config.api_keys["anthropic"] || ""}
                    onChange={(e) => handleKeyChange("anthropic", e.target.value)}
                    placeholder="sk-ant-..."
                  />
                </div>
              </div>

              <div className="settings-field">
                <label className="settings-label">DeepSeek API Key</label>
                <div className="settings-password-input">
                  <input
                    type="password"
                    className="settings-input"
                    value={config.api_keys["deepseek"] || ""}
                    onChange={(e) => handleKeyChange("deepseek", e.target.value)}
                    placeholder="sk-ds-..."
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <i className="bx bx-loader-alt bx-spin" />
                Validating & Saving...
              </>
            ) : (
              <>
                <i className="bx bx-save" />
                Save Settings
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
