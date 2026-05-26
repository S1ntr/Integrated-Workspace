use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

// ─── File system types ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileInfo {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<FileInfo>>,
}

// ─── PTY session state ────────────────────────────────────────────────────────

struct PtySession {
    writer: Box<dyn Write + Send>,
    // Keep master alive so the PTY stays open
    _master: Box<dyn portable_pty::MasterPty + Send>,
    // Keep child alive
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState(Mutex<HashMap<String, PtySession>>);

// ─── Workspace State for Sandboxing (Remediation for Path Traversal) ─────────
#[derive(Default)]
pub struct WorkspaceState(pub Mutex<Option<String>>);

// Helper to validate that canonicalized targets are strictly within picked workspace parent boundaries
fn validate_in_workspace(target_path_str: &str, workspace_opt: &Option<String>) -> Result<std::path::PathBuf, String> {
    let ws_dir = workspace_opt.as_ref().ok_or_else(|| "Access denied: No active workspace directory selected in backend.".to_string())?;
    
    let ws_path = Path::new(ws_dir).canonicalize()
        .map_err(|e| format!("Access denied: Workspace directory invalid or not found: {}", e))?;
        
    let target_path = Path::new(target_path_str);
    let canonical_target = target_path.canonicalize()
        .map_err(|e| format!("Access denied: File/Folder not found or invalid path: {}", e))?;
        
    // Enforce scoping
    if canonical_target.starts_with(&ws_path) {
        Ok(canonical_target)
    } else {
        Err("Access denied: Target path lies outside the authorized workspace sandbox.".to_string())
    }
}

// ─── PTY commands ─────────────────────────────────────────────────────────────

/// Create a new PTY session and spawn a shell (or the given command).
/// Streams output back to the frontend via the event `pty-data-{session_id}`.
#[tauri::command]
fn pty_create(
    session_id: String,
    command: String,
    cwd: String,
    rows: u16,
    cols: u16,
    app: AppHandle,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    // Kill any existing session with this id first
    {
        let mut sessions = state.0.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
        sessions.remove(&session_id);
    }

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Build the command
    // Known TUI/CLI tools that need to run directly (not through a shell wrapper)
    let tui_tools = ["opencode", "codex", "claude", "antigravity", "aider", "continue"];
    let is_tui = tui_tools.iter().any(|t| command.starts_with(t));

    let mut cmd = if cfg!(target_os = "windows") {
        if command == "shell" || command.is_empty() {
            // Native PowerShell session
            let mut c = CommandBuilder::new("powershell.exe");
            c.args(&["-NoLogo", "-NoExit"]);
            c
        } else if is_tui {
            // Launch the TUI tool directly (cmd.exe style — it finds executables in PATH)
            // Using cmd /k so the window stays open if the tool exits
            let mut c = CommandBuilder::new("cmd.exe");
            c.args(&["/k", &command]);
            c
        } else {
            // Generic command through PowerShell
            let mut c = CommandBuilder::new("powershell.exe");
            c.args(&["-NoLogo", "-NoExit", "-Command", &command]);
            c
        }
    } else {
        if command == "shell" || command.is_empty() {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
            CommandBuilder::new(&shell)
        } else {
            // Direct execution for all commands on Unix
            CommandBuilder::new(&command)
        }
    };

    // Set working directory
    if !cwd.is_empty() && Path::new(&cwd).exists() {
        cmd.cwd(&cwd);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    // Drop slave — master keeps the connection alive
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    // Store session
    {
        let mut sessions = state.0.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
        sessions.insert(
            session_id.clone(),
            PtySession {
                writer,
                _master: pair.master,
                _child: child,
            },
        );
    }

    // Spawn reader thread — streams PTY output to frontend via events
    let sid = session_id.clone();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let event_name = format!("pty-data-{}", sid);
                    let _ = app_clone.emit(&event_name, data);
                }
                Err(_) => break,
            }
        }
        // Emit exit event
        let _ = app_clone.emit(&format!("pty-exit-{}", sid), ());
    });

    Ok(())
}

/// Send input (keystrokes) to a PTY session.
#[tauri::command]
fn pty_write(
    session_id: String,
    data: String,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    if let Some(session) = sessions.get_mut(&session_id) {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Write failed: {}", e))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("Flush failed: {}", e))?;
        Ok(())
    } else {
        Err(format!("No PTY session with id '{}'", session_id))
    }
}

/// Resize a PTY session.
#[tauri::command]
fn pty_resize(
    session_id: String,
    rows: u16,
    cols: u16,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let sessions = state.0.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    if let Some(session) = sessions.get(&session_id) {
        session
            ._master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize failed: {}", e))?;
        Ok(())
    } else {
        Err(format!("No PTY session with id '{}'", session_id))
    }
}

/// Kill and remove a PTY session.
#[tauri::command]
fn pty_kill(session_id: String, state: State<'_, PtyState>) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    sessions.remove(&session_id);
    Ok(())
}

// ─── File system commands ─────────────────────────────────────────────────────

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn select_directory(state: State<'_, WorkspaceState>) -> Option<String> {
    let dir = rfd::FileDialog::new()
        .set_title("Select Integraded Workspace Directory")
        .pick_folder();
    if let Some(ref p) = dir {
        let path_str = p.to_string_lossy().to_string();
        if let Ok(mut ws) = state.0.lock() {
            *ws = Some(path_str);
        }
    }
    dir.map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn set_active_workspace(dir_path: String, state: State<'_, WorkspaceState>) -> Result<(), String> {
    let path = Path::new(&dir_path);
    if !path.exists() || !path.is_dir() {
        return Err("Directory does not exist".to_string());
    }
    let canonical = path.canonicalize()
        .map_err(|e| format!("Failed to canonicalize workspace: {}", e))?;
    if let Ok(mut ws) = state.0.lock() {
        *ws = Some(canonical.to_string_lossy().to_string());
    }
    Ok(())
}

#[tauri::command]
fn list_files(dir_path: &str, state: State<'_, WorkspaceState>) -> Result<Vec<FileInfo>, String> {
    let ws_opt = state.0.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let canonical_dir = validate_in_workspace(dir_path, &ws_opt)?;

    if !canonical_dir.exists() {
        return Err("Directory does not exist".into());
    }

    fn read_dir_recursive(dir: &Path, depth: usize) -> std::io::Result<Vec<FileInfo>> {
        let mut files = Vec::new();
        if depth > 4 {
            return Ok(files);
        }

        if dir.is_dir() {
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let file_path = entry.path();
                let file_name = entry.file_name().to_string_lossy().to_string();
                let is_dir = file_path.is_dir();

                if file_name == "node_modules"
                    || file_name == ".git"
                    || file_name == "target"
                    || file_name == "dist"
                    || file_name == ".idea"
                    || file_name == ".vscode"
                    || file_name == "build"
                    || file_name.starts_with('.')
                {
                    continue;
                }

                let children = if is_dir {
                    Some(read_dir_recursive(&file_path, depth + 1)?)
                } else {
                    None
                };

                files.push(FileInfo {
                    name: file_name,
                    path: file_path.to_string_lossy().to_string(),
                    is_dir,
                    children,
                });
            }
        }

        files.sort_by(|a, b| {
            if a.is_dir != b.is_dir {
                b.is_dir.cmp(&a.is_dir)
            } else {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            }
        });

        Ok(files)
    }

    read_dir_recursive(&canonical_dir, 0).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file_content(file_path: &str, state: State<'_, WorkspaceState>) -> Result<String, String> {
    let ws_opt = state.0.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let canonical_file = validate_in_workspace(file_path, &ws_opt)?;
    fs::read_to_string(canonical_file).map_err(|e| e.to_string())
}

#[tauri::command]
fn check_agent_installed(agent_name: &str) -> bool {
    let check_binary = match agent_name {
        "conex" => "conex",
        "cloud" => "cloud-agent",
        "open_code" => "opencode",
        "antigravity" => "antigravity",
        _ => return false,
    };

    let check_cmd = if cfg!(target_os = "windows") { "where" } else { "which" };
    match Command::new(check_cmd).arg(check_binary).output() {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub provider: String,
    pub lmstudio_url: String,
    pub ollama_url: String,
    pub cloud_provider: String,
    pub active_model: String,
    pub api_keys: HashMap<String, String>,
}

// ─── Machine-Bound Dynamic Cipher (Remediation for Hardcoded Secret Keys) ─────
fn get_dynamic_key() -> Vec<u8> {
    let mut key = b"INTEGRADED_DYNAMIC_CIPHER_CORE_KEY_".to_vec();
    
    // Windows host environmental vectors
    if let Ok(val) = std::env::var("USERNAME") {
        key.extend_from_slice(val.as_bytes());
    }
    if let Ok(val) = std::env::var("COMPUTERNAME") {
        key.extend_from_slice(val.as_bytes());
    }
    if let Ok(val) = std::env::var("USERPROFILE") {
        key.extend_from_slice(val.as_bytes());
    }
    
    // Unix/Linux/macOS host environmental vectors
    if let Ok(val) = std::env::var("USER") {
        key.extend_from_slice(val.as_bytes());
    }
    if let Ok(val) = std::env::var("HOSTNAME") {
        key.extend_from_slice(val.as_bytes());
    }
    if let Ok(val) = std::env::var("HOME") {
        key.extend_from_slice(val.as_bytes());
    }
    
    // Safety fallback padding
    if key.len() < 40 {
        key.extend_from_slice(b"SECURE_HARDENED_INTEGRADED_CIPHER_FALLBACK_VAL_1985_!");
    }
    
    key
}

fn scramble(data: &str) -> String {
    let key = get_dynamic_key();
    let mut scrambled = Vec::new();
    for (i, byte) in data.as_bytes().iter().enumerate() {
        scrambled.push(byte ^ key[i % key.len()]);
    }
    scrambled.iter().map(|b| format!("{:02x}", b)).collect()
}

fn unscramble(hex_str: &str) -> Result<String, String> {
    let key = get_dynamic_key();
    let mut scrambled = Vec::new();
    let mut chars = hex_str.chars();
    while let (Some(c1), Some(c2)) = (chars.next(), chars.next()) {
        let byte_str = format!("{}{}", c1, c2);
        let byte = u8::from_str_radix(&byte_str, 16)
            .map_err(|e| format!("Invalid hex: {}", e))?;
        scrambled.push(byte);
    }
    
    let mut unscrambled = Vec::new();
    for (i, byte) in scrambled.iter().enumerate() {
        unscrambled.push(byte ^ key[i % key.len()]);
    }
    
    String::from_utf8(unscrambled).map_err(|e| format!("Invalid UTF-8: {}", e))
}

fn get_config_path() -> Result<std::path::PathBuf, String> {
    let home = if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE").map(std::path::PathBuf::from)
    } else {
        std::env::var("HOME").map(std::path::PathBuf::from)
    }
    .map_err(|_| "Could not find home directory".to_string())?;
    
    let dir = home.join(".integrated-workspace");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    Ok(dir.join("config.json"))
}

#[tauri::command]
fn save_config(mut config: AppConfig) -> Result<(), String> {
    let path = get_config_path()?;
    
    // Load existing config to check for unchanged masked keys
    let existing = if path.exists() {
        let json = fs::read_to_string(&path).ok();
        json.and_then(|j| serde_json::from_str::<AppConfig>(&j).ok())
    } else {
        None
    };
    
    for (k, val) in config.api_keys.iter_mut() {
        if val == "••••••••••••••••" {
            // Retrieve previous encrypted scrambled key
            if let Some(ref ext) = existing {
                if let Some(existing_val) = ext.api_keys.get(k) {
                    *val = existing_val.clone();
                    continue;
                }
            }
            *val = "".to_string();
        } else if !val.is_empty() {
            // Scramble new credentials
            *val = scramble(val);
        }
    }
    
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    
    fs::write(path, json).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

#[tauri::command]
fn load_config() -> Result<AppConfig, String> {
    let path = get_config_path()?;
    if !path.exists() {
        return Ok(AppConfig {
            provider: "cloud".to_string(),
            lmstudio_url: "http://localhost:1234".to_string(),
            ollama_url: "http://localhost:11434".to_string(),
            cloud_provider: "openai".to_string(),
            active_model: "".to_string(),
            api_keys: HashMap::new(),
        });
    }
    
    let json = fs::read_to_string(path).map_err(|e| format!("Failed to read config: {}", e))?;
    let mut config: AppConfig = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse config: {}", e))?;
    
    for (_k, val) in config.api_keys.iter_mut() {
        if !val.is_empty() {
            // Check that the keys on frontend are returned ONLY as masked placeholder value
            // Plaintext decrypted secrets are strictly confined to the backend
            if unscramble(val).is_ok() {
                *val = "••••••••••••••••".to_string();
            }
        }
    }
    
    Ok(config)
}

// ─── Outbound Destination Whitelisting (SSRF Mitigation) ──────────────────────
fn validate_url(url: &str) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Access Denied: Only HTTP and HTTPS protocol endpoints are allowed.".to_string());
    }
    
    let parsed_url = url.to_lowercase();
    
    let is_allowed = parsed_url.starts_with("http://localhost:")
        || parsed_url.starts_with("http://127.0.0.1:")
        || parsed_url.starts_with("https://api.openai.com/")
        || parsed_url.starts_with("https://api.anthropic.com/")
        || parsed_url.starts_with("https://api.deepseek.com/");
        
    if is_allowed {
        Ok(())
    } else {
        Err("Access Denied: Destination URL is not in the secure API white-list.".to_string())
    }
}

#[tauri::command]
fn curl_get(url: String) -> Result<String, String> {
    validate_url(&url)?;
    
    let output = Command::new("curl")
        .args(&["-s", "-N", &url])
        .output()
        .map_err(|e| format!("Failed to execute curl: {}", e))?;
    
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("curl error: {}", stderr))
    }
}

#[tauri::command]
fn curl_post(url: String, body: String, headers: Vec<Vec<String>>) -> Result<String, String> {
    validate_url(&url)?;
    
    let mut cmd = Command::new("curl");
    cmd.args(&["-s", "-N", "-X", "POST", "-d", &body, &url]);
    for h in headers {
        if h.len() >= 2 {
            cmd.args(&["-H", &format!("{}: {}", h[0], h[1])]);
        }
    }
    
    let output = cmd.output()
        .map_err(|e| format!("Failed to execute curl: {}", e))?;
    
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("curl error: {}", stderr))
    }
}

// ─── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .manage(WorkspaceState::default())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            select_directory,
            set_active_workspace,
            list_files,
            read_file_content,
            check_agent_installed,
            pty_create,
            pty_write,
            pty_resize,
            pty_kill,
            save_config,
            load_config,
            curl_get,
            curl_post,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
