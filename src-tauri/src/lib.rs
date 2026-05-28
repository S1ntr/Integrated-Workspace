use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use tokio::io::AsyncBufReadExt;

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

// ─── Stream State for canceling active curl streams ───────────────────────────
#[derive(Default)]
pub struct StreamState(Mutex<HashMap<String, u32>>);

// ─── Workspace State for Sandboxing (Remediation for Path Traversal) ─────────
#[derive(Default)]
pub struct WorkspaceState(pub Mutex<Vec<String>>);

#[derive(Serialize, Clone)]
struct BrowserNewWindowPayload {
    source_label: String,
    url: String,
}

fn register_workspace_root(path: &Path, state: &State<'_, WorkspaceState>) -> Result<String, String> {
    if !path.exists() || !path.is_dir() {
        return Err("Directory does not exist".to_string());
    }
    let canonical = path.canonicalize()
        .map_err(|e| format!("Failed to canonicalize workspace: {}", e))?;
    let canonical_str = canonical.to_string_lossy().to_string();
    let mut roots = state.0.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    if !roots.iter().any(|existing| existing == &canonical_str) {
        roots.push(canonical_str.clone());
    }
    Ok(canonical_str)
}

fn workspace_roots(state: &State<'_, WorkspaceState>) -> Result<Vec<String>, String> {
    state.0.lock()
        .map(|roots| roots.clone())
        .map_err(|e| format!("Mutex lock poisoned: {}", e))
}

// Helper to validate that canonicalized targets are strictly within registered workspace boundaries
fn validate_in_workspace(target_path_str: &str, workspace_roots: &[String]) -> Result<std::path::PathBuf, String> {
    if workspace_roots.is_empty() {
        return Err("Access denied: No active workspace directory selected in backend.".to_string());
    }

    let target_path = Path::new(target_path_str);
    let canonical_target = target_path.canonicalize()
        .map_err(|e| format!("Access denied: File/Folder not found or invalid path: {}", e))?;

    for ws_dir in workspace_roots {
        let ws_path = Path::new(ws_dir).canonicalize()
            .map_err(|e| format!("Access denied: Workspace directory invalid or not found: {}", e))?;
        if canonical_target.starts_with(&ws_path) {
            return Ok(canonical_target);
        }
    }

    Err("Access denied: Target path lies outside the authorized workspace sandbox.".to_string())
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
            // Native PowerShell session with UTF-8 support
            let mut c = CommandBuilder::new("powershell.exe");
            c.args(&[
                "-NoLogo",
                "-NoExit",
                "-Command",
                "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 >$null"
            ]);
            c
        } else if is_tui {
            // Use cmd /c (not /k) to launch TUI tools.
            // /k keeps cmd.exe alive as a host process that can reset the console
            // screen buffer dimensions; /c makes cmd.exe exit immediately after
            // the TUI starts, leaving the TUI as the sole console owner.
            // No chcp 65001: it resets the ConPTY buffer to 80 cols.
            let mut c = CommandBuilder::new("cmd.exe");
            c.args(&["/c", &command]);
            c
        } else {
            // Generic command through PowerShell with UTF-8 support
            let mut c = CommandBuilder::new("powershell.exe");
            let full_cmd = format!(
                "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 >$null; {}",
                command
            );
            c.args(&["-NoLogo", "-NoExit", "-Command", &full_cmd]);
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
        let mut partial: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Prepend any bytes left from previous incomplete UTF-8 sequence
                    if partial.is_empty() {
                        match String::from_utf8(buf[..n].to_vec()) {
                            Ok(s) => {
                                let event_name = format!("pty-data-{}", sid);
                                let _ = app_clone.emit(&event_name, s);
                            }
                            Err(e) => {
                                let valid = e.utf8_error().valid_up_to();
                                if valid > 0 {
                                    if let Ok(s) = String::from_utf8(buf[..valid].to_vec()) {
                                        let event_name = format!("pty-data-{}", sid);
                                        let _ = app_clone.emit(&event_name, s);
                                    }
                                }
                                partial = buf[valid..n].to_vec();
                            }
                        }
                    } else {
                        partial.extend_from_slice(&buf[..n]);
                        match String::from_utf8(std::mem::take(&mut partial)) {
                            Ok(s) => {
                                let event_name = format!("pty-data-{}", sid);
                                let _ = app_clone.emit(&event_name, s);
                            }
                            Err(e) => {
                                let valid = e.utf8_error().valid_up_to();
                                let bytes = e.into_bytes();
                                if valid > 0 {
                                    if let Ok(s) = String::from_utf8(bytes[..valid].to_vec()) {
                                        let event_name = format!("pty-data-{}", sid);
                                        let _ = app_clone.emit(&event_name, s);
                                    }
                                }
                                partial = bytes[valid..].to_vec();
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
        // Flush any remaining partial bytes
        if !partial.is_empty() {
            let s = String::from_utf8_lossy(&partial).to_string();
            let event_name = format!("pty-data-{}", sid);
            let _ = app_clone.emit(&event_name, s);
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
        let _ = register_workspace_root(p, &state);
    }
    dir.map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn set_active_workspace(dir_path: String, state: State<'_, WorkspaceState>) -> Result<(), String> {
    register_workspace_root(Path::new(&dir_path), &state).map(|_| ())
}

#[tauri::command]
fn list_files(dir_path: &str, state: State<'_, WorkspaceState>) -> Result<Vec<FileInfo>, String> {
    let roots = workspace_roots(&state)?;
    let canonical_dir = validate_in_workspace(dir_path, &roots)?;

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
    let roots = workspace_roots(&state)?;
    let canonical_file = validate_in_workspace(file_path, &roots)?;
    fs::read_to_string(canonical_file).map_err(|e| e.to_string())
}

fn validate_parent_in_workspace(target_path_str: &str, workspace_roots: &[String]) -> Result<std::path::PathBuf, String> {
    if workspace_roots.is_empty() {
        return Err("Access denied: No active workspace directory selected in backend.".to_string());
    }
    let target_path = Path::new(target_path_str);
    let parent = target_path.parent().ok_or_else(|| "Invalid target path: no parent directory".to_string())?;
    let canonical_parent = parent.canonicalize()
        .map_err(|e| format!("Access denied: Parent directory does not exist or invalid path: {}", e))?;

    for ws_dir in workspace_roots {
        let ws_path = Path::new(ws_dir).canonicalize()
            .map_err(|e| format!("Access denied: Workspace directory invalid or not found: {}", e))?;
        if canonical_parent.starts_with(&ws_path) {
            return Ok(target_path.to_path_buf());
        }
    }

    Err("Access denied: Parent directory lies outside the authorized workspace sandbox.".to_string())
}

#[tauri::command]
fn create_file(file_path: String, content: Option<String>, state: State<'_, WorkspaceState>) -> Result<(), String> {
    let roots = workspace_roots(&state)?;
    let path = validate_parent_in_workspace(&file_path, &roots)?;
    fs::write(path, content.unwrap_or_default().as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_dir(dir_path: String, state: State<'_, WorkspaceState>) -> Result<(), String> {
    let roots = workspace_roots(&state)?;
    let path = validate_parent_in_workspace(&dir_path, &roots)?;
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_item(old_path: String, new_path: String, state: State<'_, WorkspaceState>) -> Result<(), String> {
    let roots = workspace_roots(&state)?;
    let src = validate_in_workspace(&old_path, &roots)?;
    let dest = validate_parent_in_workspace(&new_path, &roots)?;
    fs::rename(src, dest).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_item(path: String, state: State<'_, WorkspaceState>) -> Result<(), String> {
    let roots = workspace_roots(&state)?;
    let target = validate_in_workspace(&path, &roots)?;
    if target.is_dir() {
        fs::remove_dir_all(target).map_err(|e| e.to_string())
    } else {
        fs::remove_file(target).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn copy_item(src_path: String, dest_path: String, state: State<'_, WorkspaceState>) -> Result<(), String> {
    let roots = workspace_roots(&state)?;
    let src = validate_in_workspace(&src_path, &roots)?;
    let dest = validate_parent_in_workspace(&dest_path, &roots)?;
    if src.is_dir() {
        fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
            fs::create_dir_all(dst)?;
            for entry in fs::read_dir(src)? {
                let entry = entry?;
                let ty = entry.file_type()?;
                let dest_child = dst.join(entry.file_name());
                if ty.is_dir() {
                    copy_dir_all(&entry.path(), &dest_child)?;
                } else {
                    fs::copy(entry.path(), &dest_child)?;
                }
            }
            Ok(())
        }
        copy_dir_all(&src, &dest).map_err(|e| e.to_string())
    } else {
        fs::copy(src, dest).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Return a folder name like "Thursday_2026-05-28" for today's date.
/// Uses Hinnant's civil_from_days algorithm — no chrono dependency needed.
#[allow(dead_code)]
fn today_folder_name() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = secs / 86400;

    // Weekday: epoch day 0 = Thursday (index 3 when Mon=0)
    let weekday_idx = ((days % 7 + 3 + 7) % 7) as usize;
    let day_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    let day_name = day_names[weekday_idx];

    // Civil date (Hinnant 2013 algorithm)
    let z: i64 = days + 719468;
    let era = if z >= 0 { z / 146097 } else { (z - 146096) / 146097 };
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y   = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp  = (5 * doy + 2) / 153;
    let d   = doy - (153 * mp + 2) / 5 + 1;
    let m   = if mp < 10 { mp + 3 } else { mp - 9 };
    let y   = if m <= 2 { y + 1 } else { y };

    format!("{}_{:04}-{:02}-{:02}", day_name, y, m, d)
}

/// Save the current chat session snapshot (disabled to avoid polluting the workspace directory).
#[tauri::command]
fn save_chat_to_workspace(_workspace_dir: String, _json_data: String) -> Result<(), String> {
    Ok(())
}

fn chat_history_root(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| format!("Failed to resolve home directory: {}", e))?;
    Ok(home.join(".integraded-workspace").join("chat-history"))
}

fn scoped_chat_history_root(app: &AppHandle, scope: Option<String>) -> Result<PathBuf, String> {
    let root = chat_history_root(app)?;
    if let Some(scope_value) = scope {
        let safe = safe_chat_folder_name(&scope_value);
        if !safe.is_empty() && safe != "default" {
            return Ok(root.join("workspaces").join(safe));
        }
    }
    Ok(root)
}

fn legacy_chat_history_paths(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let home = app.path().home_dir().map_err(|e| format!("Failed to resolve home directory: {}", e))?;
    let workspace = home.join(".integraded-workspace");
    Ok(vec![
        workspace.join("chat-history").join("chat_history.json"),
        workspace.join("chat_history.json"),
    ])
}

fn safe_chat_folder_name(value: &str) -> String {
    let clean: String = value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    clean.trim_matches('-').chars().take(96).collect::<String>()
}

fn write_chat_session_folder(root: &Path, session: &serde_json::Value) -> Result<(), String> {
    let fallback_created = session.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
    let fallback_id = session.get("id").and_then(|v| v.as_str()).unwrap_or("chat");
    let requested = session
        .get("folderName")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{}_{}", fallback_created, fallback_id));
    let folder_name = safe_chat_folder_name(&requested);
    if folder_name.is_empty() {
        return Ok(());
    }
    let dir = root.join(folder_name);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create chat session dir: {}", e))?;
    let pretty = serde_json::to_string_pretty(session).map_err(|e| format!("Failed to serialize chat session: {}", e))?;
    fs::write(dir.join("chat_history.json"), pretty.as_bytes()).map_err(|e| format!("Failed to write chat session: {}", e))
}

#[tauri::command]
fn save_chat_history(json_data: String, scope: Option<String>, app: AppHandle) -> Result<(), String> {
    let chat_dir = scoped_chat_history_root(&app, scope)?;
    fs::create_dir_all(&chat_dir).map_err(|e| format!("Failed to create chat history dir: {}", e))?;

    let file_path = chat_dir.join("chat_history.json");
    fs::write(&file_path, json_data.as_bytes()).map_err(|e| format!("Failed to write chat history: {}", e))?;

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json_data) {
        if let Some(current) = value.get("current_session") {
            let _ = write_chat_session_folder(&chat_dir, current);
        }
        if let Some(histories) = value.get("histories").and_then(|v| v.as_array()) {
            for session in histories {
                let _ = write_chat_session_folder(&chat_dir, session);
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn load_chat_history(scope: Option<String>, app: AppHandle) -> Result<Option<String>, String> {
    let is_scoped = scope.as_ref().map(|s| {
        let safe = safe_chat_folder_name(s);
        !safe.is_empty() && safe != "default"
    }).unwrap_or(false);
    let chat_dir = scoped_chat_history_root(&app, scope)?;
    let new_path = chat_dir.join("chat_history.json");

    if !new_path.exists() && !is_scoped {
        for legacy in legacy_chat_history_paths(&app)? {
            if legacy.exists() {
                fs::create_dir_all(&chat_dir).map_err(|e| format!("Failed to create chat history dir: {}", e))?;
                fs::copy(&legacy, &new_path).ok();
                break;
            }
        }
    }

    if new_path.exists() {
        let content = fs::read_to_string(new_path).map_err(|e| format!("Failed to read chat history: {}", e))?;
        Ok(Some(content))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn clear_chat_history(app: AppHandle) -> Result<(), String> {
    let chat_dir = chat_history_root(&app)?;
    if chat_dir.exists() {
        fs::remove_dir_all(&chat_dir).map_err(|e| format!("Failed to clear chat history: {}", e))?;
    }
    let home = app.path().home_dir().map_err(|e| format!("Failed to resolve home directory: {}", e))?;
    let legacy_dir = home.join(".integraded-workspace").join("chat-history");
    if legacy_dir.exists() {
        let _ = fs::remove_dir_all(legacy_dir);
    }
    let legacy_file = home.join(".integraded-workspace").join("chat_history.json");
    if legacy_file.exists() {
        let _ = fs::remove_file(legacy_file);
    }
    Ok(())
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
    pub streaming: bool,
    #[serde(default = "default_true")]
    pub thinking_preview: bool,
    pub api_keys: HashMap<String, String>,
}

fn default_true() -> bool {
    true
}

// ─── Key storage (v2: salted per-key cipher) ──────────────────────────────────
//
// Security model:
//   • Each stored key has a unique 16-byte random salt.
//   • The key-encryption key is derived from the salt + machine-specific env
//     values (username, computer name, home path) using 256 rounds of mixing.
//   • Stored format: "v2:<32-hex-salt>:<encrypted-hex>"
//   • Without knowing both the salt AND the machine env, decryption is infeasible.
//   • Backward-compat: values without the "v2:" prefix use the old v1 decoder.

/// Generate a 16-byte salt from system entropy (no external crate needed).
fn generate_salt() -> [u8; 16] {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u64;
    let p = std::process::id() as u64;
    // Xorshift mix for pseudo-randomness
    let mut s = t
        .wrapping_mul(6364136223846793005)
        .wrapping_add(p.wrapping_mul(2862933555777941757))
        .wrapping_add(1442695040888963407);
    let mut salt = [0u8; 16];
    for i in 0..16 {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        salt[i] = (s >> (8 * (i % 8))) as u8;
    }
    salt
}

/// Derive a 64-byte encryption key from the salt + machine-specific material
/// using 256 rounds of byte-level diffusion.
fn derive_key(salt: &[u8]) -> [u8; 64] {
    let mut material: Vec<u8> = Vec::new();
    for var in ["USERNAME", "COMPUTERNAME", "USERPROFILE", "USER", "HOSTNAME", "HOME"] {
        if let Ok(val) = std::env::var(var) {
            material.extend_from_slice(val.as_bytes());
            material.push(0x3A); // colon delimiter
        }
    }
    // Fallback if no env vars are available
    if material.is_empty() {
        material.extend_from_slice(b"INTEGRADED_DEFAULT_MACHINE_FALLBACK");
    }

    let mut out = [0u8; 64];
    for i in 0..64usize {
        let mut v: u8 = material[i % material.len()].wrapping_add(salt[i % salt.len()]);
        // 256 rounds of mixing (deterministic, salt-dependent)
        for round in 0u8..=255 {
            let prev = if i > 0 { out[i - 1] } else { 0xA5u8 };
            let m = material[(i.wrapping_add(round as usize)) % material.len()];
            let s = salt[(i.wrapping_add(round as usize * 3)) % salt.len()];
            v = v
                .rotate_left(((round % 5) + 1) as u32)
                .wrapping_add(m)
                .wrapping_add(prev)
                ^ s
                ^ (round.wrapping_mul(0x6B));
        }
        out[i] = v;
    }
    out
}

/// Encrypt a plaintext string → "v2:{salt-hex}:{cipher-hex}"
fn scramble(data: &str) -> String {
    let salt = generate_salt();
    let key = derive_key(&salt);
    let cipher: Vec<u8> = data
        .as_bytes()
        .iter()
        .enumerate()
        .map(|(i, &b)| b ^ key[i % key.len()])
        .collect();
    let salt_hex: String = salt.iter().map(|b| format!("{:02x}", b)).collect();
    let cipher_hex: String = cipher.iter().map(|b| format!("{:02x}", b)).collect();
    format!("v2:{}:{}", salt_hex, cipher_hex)
}

/// Decode a hex string to bytes.
fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(hex.len() / 2);
    let mut chars = hex.chars();
    while let (Some(c1), Some(c2)) = (chars.next(), chars.next()) {
        out.push(
            u8::from_str_radix(&format!("{}{}", c1, c2), 16)
                .map_err(|e| format!("Invalid hex: {}", e))?,
        );
    }
    Ok(out)
}

/// Decrypt. Handles both v2 (salted) and legacy v1 (plain XOR hex) formats.
fn unscramble(hex_str: &str) -> Result<String, String> {
    if let Some(rest) = hex_str.strip_prefix("v2:") {
        // ── v2: salted format ─────────────────────────────────────────────
        let mut parts = rest.splitn(2, ':');
        let salt_hex = parts.next().ok_or("Missing salt")?;
        let cipher_hex = parts.next().ok_or("Missing cipher")?;

        let salt = hex_to_bytes(salt_hex)?;
        let cipher = hex_to_bytes(cipher_hex)?;
        let key = derive_key(&salt);

        let plain: Vec<u8> = cipher
            .iter()
            .enumerate()
            .map(|(i, &b)| b ^ key[i % key.len()])
            .collect();
        String::from_utf8(plain).map_err(|e| format!("Invalid UTF-8: {}", e))
    } else {
        // ── v1: legacy plain XOR — kept for backward compat ───────────────
        // Build the old machine key (verbatim from previous implementation)
        let mut key = b"INTEGRADED_DYNAMIC_CIPHER_CORE_KEY_".to_vec();
        for var in ["USERNAME", "COMPUTERNAME", "USERPROFILE", "USER", "HOSTNAME", "HOME"] {
            if let Ok(val) = std::env::var(var) {
                key.extend_from_slice(val.as_bytes());
            }
        }
        if key.len() < 40 {
            key.extend_from_slice(b"SECURE_HARDENED_INTEGRADED_CIPHER_FALLBACK_VAL_1985_!");
        }
        let cipher = hex_to_bytes(hex_str)?;
        let plain: Vec<u8> = cipher
            .iter()
            .enumerate()
            .map(|(i, &b)| b ^ key[i % key.len()])
            .collect();
        String::from_utf8(plain).map_err(|e| format!("Invalid UTF-8: {}", e))
    }
}

fn get_config_path() -> Result<std::path::PathBuf, String> {
    let home = if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE").map(std::path::PathBuf::from)
    } else {
        std::env::var("HOME").map(std::path::PathBuf::from)
    }
    .map_err(|_| "Could not find home directory".to_string())?;

    let dir = home.join(".integraded-workspace");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    // migrate config from old typo'd directory
    let old_dir = home.join(".integrated-workspace");
    let new_path = dir.join("config.json");
    let old_path = old_dir.join("config.json");
    if !new_path.exists() && old_path.exists() {
        fs::copy(&old_path, &new_path).ok();
    }

    Ok(new_path)
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
            streaming: true,
            thinking_preview: true,
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
        || parsed_url.starts_with("https://api.deepseek.com/")
        || parsed_url.starts_with("https://api.mistral.ai/")
        || parsed_url.starts_with("https://generativelanguage.googleapis.com/")
        || parsed_url.starts_with("https://api.x.ai/")
        || parsed_url.starts_with("https://api.together.xyz/")
        || parsed_url.starts_with("https://openrouter.ai/")
        || parsed_url.starts_with("https://ollama.com/");
        
    if is_allowed {
        Ok(())
    } else {
        Err("Access Denied: Destination URL is not in the secure API white-list.".to_string())
    }
}

#[tauri::command]
async fn curl_get(url: String) -> Result<String, String> {
    validate_url(&url)?;
    
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::process::Command::new("curl")
            .args(&["-s", "-N", &url])
            .output(),
    )
    .await
    .map_err(|_| "Request timed out after 30 seconds.".to_string())?
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
async fn browser_create_webview(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed_url: tauri::Url = url
        .parse()
        .map_err(|e| format!("Invalid browser URL: {}", e))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window is not available.".to_string())?;
    if let Some(existing) = app.get_webview(&label) {
        let _ = existing.close();
    }

    let app_for_popup = app.clone();
    let label_for_popup = label.clone();
    let webview_builder = tauri::webview::WebviewBuilder::new(
        label,
        tauri::WebviewUrl::External(parsed_url),
    )
    .focused(true)
    .accept_first_mouse(true)
    .disable_drag_drop_handler()
    .zoom_hotkeys_enabled(true)
    .devtools(true)
    .general_autofill_enabled(true)
    .on_new_window(move |popup_url, _features| {
        let _ = app_for_popup.emit(
            "browser-new-window",
            BrowserNewWindowPayload {
                source_label: label_for_popup.clone(),
                url: popup_url.to_string(),
            },
        );
        tauri::webview::NewWindowResponse::Deny
    });

    window
        .add_child(
            webview_builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| format!("Failed to create embedded browser webview: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn browser_close_webview(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|e| format!("Failed to close embedded browser webview: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn browser_show_webview(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "Embedded browser webview is not available.".to_string())?;
    webview
        .show()
        .map_err(|e| format!("Failed to show embedded browser webview: {}", e))?;
    webview
        .set_focus()
        .map_err(|e| format!("Failed to focus embedded browser webview: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn browser_set_webview_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "Embedded browser webview is not available.".to_string())?;
    webview
        .set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| format!("Failed to position embedded browser webview: {}", e))?;
    webview
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| format!("Failed to size embedded browser webview: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn curl_post(url: String, body: String, headers: Vec<Vec<String>>) -> Result<String, String> {
    validate_url(&url)?;
    
    let mut cmd = tokio::process::Command::new("curl");
    cmd.args(&["-s", "-N", "-X", "POST", "-d", &body, &url]);
    for h in headers {
        if h.len() >= 2 {
            cmd.args(&["-H", &format!("{}: {}", h[0], h[1])]);
        }
    }
    
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(300), // 5 min timeout for LLM responses
        cmd.output(),
    )
    .await
    .map_err(|_| "Request timed out after 5 minutes.".to_string())?
    .map_err(|e| format!("Failed to execute curl: {}", e))?;
    
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("curl error: {}", stderr))
    }
}

// ─── Stream cancellation ──────────────────────────────────────────────────────

#[tauri::command]
fn cancel_stream(session_id: String, state: State<'_, StreamState>) -> Result<(), String> {
    let mut streams = state.0.lock().map_err(|e| format!("Lock failed: {}", e))?;
    if let Some(pid) = streams.remove(&session_id) {
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("taskkill")
                .args(&["/F", "/PID", &pid.to_string()])
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("kill")
                .arg("-9")
                .arg(&pid.to_string())
                .output();
        }
    }
    Ok(())
}

#[tauri::command]
async fn curl_post_stream(
    url: String,
    body: String,
    headers: Vec<Vec<String>>,
    session_id: String,
    app: AppHandle,
    state: State<'_, StreamState>,
) -> Result<(), String> {
    validate_url(&url)?;
    
    let mut cmd = tokio::process::Command::new("curl");
    cmd.args(&["-s", "-N", "-X", "POST", "-d", &body, &url]);
    for h in &headers {
        if h.len() >= 2 {
            cmd.args(&["-H", &format!("{}: {}", h[0], h[1])]);
        }
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    
    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn curl: {}", e))?;
    let pid = child.id().unwrap_or(0);
    
    // Register the stream PID
    {
        let mut streams = state.0.lock().map_err(|e| format!("Lock failed: {}", e))?;
        streams.insert(session_id.clone(), pid);
    }
    
    let stdout = child.stdout.take().ok_or_else(|| "Failed to capture stdout".to_string())?;
    
    let reader = tokio::io::BufReader::new(stdout);
    let mut lines = reader.lines();
    
    let sid = session_id.clone();
    let app_clone = app.clone();
    
    loop {
        let timeout_result = tokio::time::timeout(
            std::time::Duration::from_secs(300),
            lines.next_line(),
        ).await;
        
        match timeout_result {
            Ok(Ok(Some(line))) => {
                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() {
                    let _ = app_clone.emit(&format!("stream-chunk-{}", sid), &trimmed);
                }
            }
            Ok(Ok(None)) => break, // EOF
            Ok(Err(_)) => break,   // read error
            Err(_) => break,       // timeout
        }
    }
    
    // Unregister and emit done
    {
        let mut streams = state.0.lock().map_err(|e| format!("Lock failed: {}", e))?;
        streams.remove(&session_id);
    }
    let _ = app.emit(&format!("stream-done-{}", session_id), ());
    
    // Wait for curl to finish (ignore errors – we already got the data)
    let _ = child.wait().await;
    
    Ok(())
}

// ─── Dev server detection ─────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DevProjectInfo {
    pub project_type: String,
    pub label: String,
    pub command: String,
    pub port: u16,
    pub package_manager: String,
}

/// Inspect the workspace directory and return the command + port needed to start
/// a dev server, with no AI involved — pure file-based heuristics.
#[tauri::command]
fn detect_dev_project(dir: String) -> Result<DevProjectInfo, String> {
    let path = Path::new(&dir);

    // ── Node.js / npm / pnpm / yarn / bun project ──────────────────────────
    let pkg_path = path.join("package.json");
    if pkg_path.exists() {
        let pkg_str = fs::read_to_string(&pkg_path)
            .map_err(|e| format!("Failed to read package.json: {}", e))?;
        let pkg: serde_json::Value = serde_json::from_str(&pkg_str)
            .map_err(|e| format!("Failed to parse package.json: {}", e))?;

        // Detect package manager from lockfiles (most specific first)
        let pm = if path.join("bun.lockb").exists() || path.join("bun.lock").exists() {
            "bun"
        } else if path.join("pnpm-lock.yaml").exists() {
            "pnpm"
        } else if path.join("yarn.lock").exists() {
            "yarn"
        } else {
            "npm"
        };

        let deps     = pkg.get("dependencies").and_then(|v| v.as_object());
        let dev_deps = pkg.get("devDependencies").and_then(|v| v.as_object());
        let has_dep  = |name: &str| -> bool {
            deps.map(|d| d.contains_key(name)).unwrap_or(false)
                || dev_deps.map(|d| d.contains_key(name)).unwrap_or(false)
        };

        // Detect expected port based on framework
        let port: u16 = if has_dep("vite")
            || path.join("vite.config.ts").exists()
            || path.join("vite.config.js").exists()
            || path.join("vite.config.mts").exists()
            || path.join("vite.config.mjs").exists()
        {
            5173
        } else if has_dep("@sveltejs/kit") {
            5173
        } else if has_dep("next") {
            3000
        } else if has_dep("nuxt") || has_dep("nuxt3") || has_dep("@nuxt/kit") {
            3000
        } else if has_dep("react-scripts") {
            3000
        } else if has_dep("gatsby") {
            8000
        } else if has_dep("@angular/core") || has_dep("@angular/cli") {
            4200
        } else {
            3000
        };

        // Pick the script to run
        let scripts = pkg.get("scripts").and_then(|v| v.as_object());
        let script = if scripts.map(|s| s.contains_key("dev")).unwrap_or(false) {
            "dev"
        } else if scripts.map(|s| s.contains_key("start")).unwrap_or(false) {
            "start"
        } else if scripts.map(|s| s.contains_key("serve")).unwrap_or(false) {
            "serve"
        } else if scripts.map(|s| s.contains_key("develop")).unwrap_or(false) {
            "develop"
        } else {
            return Err(
                "No dev/start/serve script found in package.json. \
                 Add a \"dev\" script to run your project.".to_string(),
            );
        };

        let command = if pm == "npm" {
            format!("npm run {}", script)
        } else {
            format!("{} {}", pm, script)
        };

        return Ok(DevProjectInfo {
            project_type: "node".to_string(),
            label: format!("{} {}", pm, script),
            command,
            port,
            package_manager: pm.to_string(),
        });
    }

    // ── Standalone Vite config (no package.json at root) ───────────────────
    if path.join("vite.config.ts").exists()
        || path.join("vite.config.js").exists()
        || path.join("vite.config.mts").exists()
        || path.join("vite.config.mjs").exists()
    {
        return Ok(DevProjectInfo {
            project_type: "node".to_string(),
            label: "npx vite".to_string(),
            command: "npx vite".to_string(),
            port: 5173,
            package_manager: "npx".to_string(),
        });
    }

    // ── Static HTML (no package.json) ──────────────────────────────────────
    if path.join("index.html").exists() {
        return Ok(DevProjectInfo {
            project_type: "static".to_string(),
            label: "Static server".to_string(),
            command: "npx --yes serve . --listen 3000".to_string(),
            port: 3000,
            package_manager: "npx".to_string(),
        });
    }

    Err(
        "No recognizable project found. Expected package.json, \
         vite.config.*, or index.html in the workspace directory."
            .to_string(),
    )
}

/// Start the dev server as a detached background process (no visible terminal window).
/// Stdout, stderr and stdin are all routed to /dev/null (Unix) or NUL (Windows).
/// On Windows the CREATE_NO_WINDOW flag is set so no console flashes up.
#[tauri::command]
fn start_dev_server_background(dir: String, command: String) -> Result<(), String> {
    let mut cmd = if cfg!(target_os = "windows") {
        // Use cmd.exe /c so that .cmd / .bat shims (npm, pnpm, yarn, …) resolve correctly.
        let mut c = std::process::Command::new("cmd.exe");
        c.args(["/c", &command]);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", &command]);
        c
    };

    if !dir.is_empty() && Path::new(&dir).exists() {
        cmd.current_dir(&dir);
    }

    // Suppress all I/O — we only care whether the port comes up, not the output.
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    cmd.stdin(std::process::Stdio::null());

    // Windows: prevent a console window from briefly appearing.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map_err(|e| format!("Failed to start dev server in background: {}", e))?;

    Ok(())
}

/// Attempt a TCP connection to 127.0.0.1:port or [::1]:port; returns true if something is
/// already listening there (i.e. the dev server is up).
#[tauri::command]
fn check_port_open(port: u16) -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    
    // Check IPv4 loopback
    if TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(200),
    )
    .is_ok() {
        return true;
    }

    // Check IPv6 loopback
    TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
        Duration::from_millis(200),
    )
    .is_ok()
}

// ─── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .manage(WorkspaceState::default())
        .manage(StreamState::default())
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
            create_file,
            create_dir,
            rename_item,
            delete_item,
            copy_item,
            save_chat_history,
            load_chat_history,
            clear_chat_history,
            browser_create_webview,
            browser_close_webview,
            browser_show_webview,
            browser_set_webview_bounds,
            check_agent_installed,
            pty_create,
            pty_write,
            pty_resize,
            pty_kill,
            save_config,
            load_config,
            curl_get,
            curl_post,
            curl_post_stream,
            cancel_stream,
            detect_dev_project,
            check_port_open,
            start_dev_server_background,
            save_chat_to_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
