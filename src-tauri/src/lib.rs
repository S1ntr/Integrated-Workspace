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

// ─── Dev Server State — tracks spawned background PID so we can kill it ───────
#[derive(Default)]
pub struct DevServerState(Mutex<Option<u32>>);

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
        // Pre-compute event names once — avoids a heap allocation per read() call.
        let data_event = format!("pty-data-{}", sid);
        let exit_event = format!("pty-exit-{}", sid);
        // Larger buffer reduces syscall frequency for high-throughput agents.
        let mut buf = [0u8; 8192];
        let mut partial: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if partial.is_empty() {
                        // Fast path: try to interpret bytes as UTF-8 without allocating.
                        match std::str::from_utf8(&buf[..n]) {
                            Ok(s) => {
                                let _ = app_clone.emit(&data_event, s);
                            }
                            Err(e) => {
                                let valid = e.valid_up_to();
                                if valid > 0 {
                                    if let Ok(s) = std::str::from_utf8(&buf[..valid]) {
                                        let _ = app_clone.emit(&data_event, s);
                                    }
                                }
                                partial = buf[valid..n].to_vec();
                            }
                        }
                    } else {
                        partial.extend_from_slice(&buf[..n]);
                        match String::from_utf8(std::mem::take(&mut partial)) {
                            Ok(s) => {
                                let _ = app_clone.emit(&data_event, s);
                            }
                            Err(e) => {
                                let valid = e.utf8_error().valid_up_to();
                                let bytes = e.into_bytes();
                                if valid > 0 {
                                    if let Ok(s) = std::str::from_utf8(&bytes[..valid]) {
                                        let _ = app_clone.emit(&data_event, s);
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
        if !partial.is_empty() {
            let s = String::from_utf8_lossy(&partial).to_string();
            let _ = app_clone.emit(&data_event, s);
        }
        let _ = app_clone.emit(&exit_event, ());
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

/// Open a native folder picker starting from `start_dir` and return the chosen path.
/// Used by the integrated browser to let the user manually pick a project subfolder.
#[tauri::command]
fn pick_project_folder(start_dir: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new().set_title("Select Project Folder");
    if let Some(ref dir) = start_dir {
        dialog = dialog.set_directory(dir);
    }
    dialog.pick_folder().map(|p| p.to_string_lossy().to_string())
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

                // Always skip heavy/noisy directories regardless of name.
                let is_blocked_dir = is_dir && (
                    file_name == "node_modules"
                    || file_name == "target"
                    || file_name == "dist"
                    || file_name == "build"
                    || file_name == ".git"
                    || file_name == ".idea"
                    || file_name == ".vscode"
                    || file_name == ".next"
                    || file_name == ".nuxt"
                    || file_name == "__pycache__"
                    // Generic hidden dirs (start with dot) — but NOT hidden files
                    || file_name.starts_with('.')
                );
                if is_blocked_dir {
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

/// Lightweight file metadata scan — returns path + mtime + size for every file
/// in the workspace tree, without reading any file contents.
/// Used by the frontend change-detector so it can compare files by metadata
/// instead of re-reading full content on every poll tick.
#[derive(Serialize, Clone)]
pub struct FileMetaEntry {
    pub path: String,
    pub mtime_secs: u64,
    pub size: u64,
}

#[tauri::command]
fn list_files_meta(dir_path: &str, state: State<'_, WorkspaceState>) -> Result<Vec<FileMetaEntry>, String> {
    let roots = workspace_roots(&state)?;
    let canonical_dir = validate_in_workspace(dir_path, &roots)?;

    fn collect(dir: &Path, depth: usize, out: &mut Vec<FileMetaEntry>) {
        if depth > 4 { return; }
        let Ok(rd) = fs::read_dir(dir) else { return; };
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                // Same block-list as list_files
                if name == "node_modules" || name == "target" || name == "dist"
                    || name == "build" || name == ".git" || name == ".idea"
                    || name == ".vscode" || name == ".next" || name == ".nuxt"
                    || name == "__pycache__" || name.starts_with('.')
                {
                    continue;
                }
                collect(&path, depth + 1, out);
            } else if let Ok(meta) = entry.metadata() {
                let mtime_secs = meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                out.push(FileMetaEntry {
                    path: path.to_string_lossy().into_owned(),
                    mtime_secs,
                    size: meta.len(),
                });
            }
        }
    }

    let mut entries = Vec::new();
    collect(&canonical_dir, 0, &mut entries);
    Ok(entries)
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

/// Copy a file/folder from OUTSIDE the workspace into the workspace.
/// Source path is NOT sandboxed — only dest is validated.
#[tauri::command]
fn paste_external_file(src_path: String, dest_path: String, state: State<'_, WorkspaceState>) -> Result<(), String> {
    let roots = workspace_roots(&state)?;
    let dest = validate_parent_in_workspace(&dest_path, &roots)?;
    let src = std::path::Path::new(&src_path);
    if !src.exists() {
        return Err(format!("Source does not exist: {}", src_path));
    }
    fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let ty = entry.file_type()?;
            let dest_child = dst.join(entry.file_name());
            if ty.is_dir() { copy_dir_all(&entry.path(), &dest_child)?; }
            else { fs::copy(entry.path(), &dest_child)?; }
        }
        Ok(())
    }
    if src.is_dir() {
        copy_dir_all(src, &dest).map_err(|e| e.to_string())
    } else {
        fs::copy(src, &dest).map(|_| ()).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn move_item(src_path: String, dest_path: String, state: State<'_, WorkspaceState>) -> Result<(), String> {
    let roots = workspace_roots(&state)?;
    let src = validate_in_workspace(&src_path, &roots)?;
    let dest = validate_parent_in_workspace(&dest_path, &roots)?;
    fs::rename(src, dest).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path.replace("/", "\\")])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let parent = std::path::Path::new(&path).parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
}

#[tauri::command]
fn get_clipboard_file_paths() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let utf8_prefix = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ";
        // Try Get-Clipboard -Format FileDropList (PowerShell 5.1+)
        let cmd1 = format!("{}try {{ $files = Get-Clipboard -Format FileDropList -ErrorAction Stop; if ($files) {{ $files | ForEach-Object {{ $_.FullName }} }} }} catch {{ }}", utf8_prefix);
        let ps = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &cmd1])
            .output();
        if let Ok(out) = ps {
            let raw = strip_utf8_bom(&out.stdout);
            let text = String::from_utf8_lossy(raw);
            let paths: Vec<String> = text.lines()
                .map(|l| l.trim().trim_end_matches('\r').to_string())
                .filter(|l| !l.is_empty())
                .collect();
            if !paths.is_empty() {
                return paths;
            }
        }
        // Fallback: Add-Type approach
        let cmd2 = format!("{}Add-Type -AssemblyName System.Windows.Forms; $files = [System.Windows.Forms.Clipboard]::GetFileDropList(); $files | ForEach-Object {{ $_ }}", utf8_prefix);
        let ps2 = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &cmd2])
            .output();
        if let Ok(out) = ps2 {
            let raw = strip_utf8_bom(&out.stdout);
            let text = String::from_utf8_lossy(raw);
            return text.lines()
                .map(|l| l.trim().trim_end_matches('\r').to_string())
                .filter(|l| !l.is_empty())
                .collect();
        }
    }
    vec![]
}

#[tauri::command]
fn run_command_in_dir(cmd: String, dir: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
        .current_dir(&dir)
        .output()
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "windows"))]
    let output = std::process::Command::new("sh")
        .args(["-c", &cmd])
        .current_dir(&dir)
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() && !stderr.is_empty() {
        return Err(stderr.trim().to_string());
    }
    Ok(if !stdout.is_empty() { stdout } else { stderr })
}

fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { bytes }
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
    #[serde(default)]
    pub disabled_providers: Vec<String>,
    /// "ask" = Accept Only (default): show confirmation before read_file/exec_cmd
    /// "bypass" = Bypass Permissions: execute all chat tools immediately
    #[serde(default = "default_ask")]
    pub chat_tool_mode: String,
}

fn default_true() -> bool { true }
fn default_ask() -> String { "ask".into() }

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            provider: "cloud".into(),
            lmstudio_url: "http://localhost:1234".into(),
            ollama_url: "http://localhost:11434".into(),
            cloud_provider: "openai".into(),
            active_model: String::new(),
            streaming: true,
            thinking_preview: true,
            api_keys: HashMap::new(),
            disabled_providers: Vec::new(),
            chat_tool_mode: "ask".into(),
        }
    }
}

// ─── Model info returned to the frontend ──────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ModelInfo {
    pub id: String,
    pub name: String, // display name (may equal id if none provided)
}

// ─── Live model fetching ───────────────────────────────────────────────────────

/// Make an authenticated GET request and return the raw response body.
async fn authed_get(url: &str, headers: &[(&str, &str)]) -> Result<String, String> {
    validate_url(url)?;
    let mut cmd = tokio::process::Command::new("curl");
    cmd.args(["-s", "-f", "--max-time", "15", url]);
    for (name, value) in headers {
        cmd.args(["-H", &format!("{}: {}", name, value)]);
    }
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        cmd.output(),
    )
    .await
    .map_err(|_| "Request timed out after 20 seconds".to_string())?
    .map_err(|e| format!("curl error: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("HTTP error: {}", stderr.lines().last().unwrap_or("unknown")))
    }
}

/// Return true if the model ID looks like a chat-capable model for OpenAI.
fn openai_is_chat_model(id: &str) -> bool {
    let id = id.to_lowercase();
    // Exclude non-chat capabilities
    let excluded = ["dall-e", "whisper", "tts", "text-embedding", "babbage",
                    "davinci", "curie", "ada", "instruct", "realtime",
                    "transcribe", "search", "similarity", "moderation"];
    if excluded.iter().any(|e| id.contains(e)) { return false; }
    // Keep gpt-*, o1, o3, o4, chatgpt
    id.starts_with("gpt-") || id.starts_with("o1") || id.starts_with("o3")
    || id.starts_with("o4") || id.starts_with("chatgpt")
}

/// Parse a provider API response into a Vec<ModelInfo>.
fn parse_models(body: &str, provider: &str) -> Result<Vec<ModelInfo>, String> {
    let json: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("JSON parse error: {}", e))?;

    let mut models: Vec<ModelInfo> = match provider {
        // ── Anthropic ─────────────────────────────────────────────────────────
        // {"data":[{"id":"claude-…","display_name":"Claude …","type":"model"}]}
        "anthropic" => {
            let arr = json["data"].as_array().ok_or("missing data array")?;
            arr.iter().filter_map(|m| {
                let id = m["id"].as_str()?.to_string();
                let name = m["display_name"].as_str().unwrap_or(&id).to_string();
                // Only include text models, skip image/vision-only ones
                Some(ModelInfo { id, name })
            }).collect()
        }

        // ── Google Gemini ─────────────────────────────────────────────────────
        // {"models":[{"name":"models/gemini-…","displayName":"…","supportedGenerationMethods":[…]}]}
        "google" => {
            let arr = json["models"].as_array().ok_or("missing models array")?;
            arr.iter().filter_map(|m| {
                let raw = m["name"].as_str()?;
                let id = raw.strip_prefix("models/").unwrap_or(raw).to_string();
                // Only models that support generateContent (chat-capable)
                let supported = m["supportedGenerationMethods"].as_array()
                    .map(|a| a.iter().any(|v| v.as_str() == Some("generateContent")))
                    .unwrap_or(false);
                if !supported { return None; }
                // Exclude embedding, aqa, legacy tuned models
                if id.contains("embedding") || id.contains("aqa") || id.contains("tuned") { return None; }
                let name = m["displayName"].as_str().unwrap_or(&id).to_string();
                Some(ModelInfo { id, name })
            }).collect()
        }

        // ── Mistral ───────────────────────────────────────────────────────────
        // {"data":[{"id":"…","capabilities":{"completion_chat":true}}]}
        "mistral" => {
            let arr = json["data"].as_array().ok_or("missing data array")?;
            arr.iter().filter_map(|m| {
                let id = m["id"].as_str()?.to_string();
                // Keep only chat-capable models
                let is_chat = m["capabilities"]["completion_chat"].as_bool().unwrap_or(true);
                if !is_chat { return None; }
                if id.contains("embed") { return None; }
                let name = m["name"].as_str().unwrap_or(&id).to_string();
                Some(ModelInfo { id, name })
            }).collect()
        }

        // ── Together AI ───────────────────────────────────────────────────────
        // Returns a top-level array: [{"id":"…","display_name":"…","type":"chat"}]
        "together" => {
            let arr = if json.is_array() {
                json.as_array().unwrap()
            } else {
                json["data"].as_array().ok_or("missing data")?
            };
            arr.iter().filter_map(|m| {
                let id = m["id"].as_str()?.to_string();
                let model_type = m["type"].as_str().unwrap_or("chat");
                // Keep chat and language models, skip image/code/embedding
                if model_type == "image" || model_type == "embedding" || model_type == "moderation" {
                    return None;
                }
                let name = m["display_name"].as_str()
                    .or_else(|| m["name"].as_str())
                    .unwrap_or(&id)
                    .to_string();
                Some(ModelInfo { id, name })
            }).collect()
        }

        // ── Ollama Cloud (ollama.com) ─────────────────────────────────────────
        // Same format as local Ollama: {"models":[{"name":"llama3.2:latest",...}]}
        "ollama_cloud" => {
            let arr = json["models"].as_array().ok_or("missing models array")?;
            arr.iter().filter_map(|m| {
                let name = m["name"].as_str()?.to_string();
                Some(ModelInfo { id: name.clone(), name })
            }).collect()
        }

        // ── OpenRouter ────────────────────────────────────────────────────────
        // {"data":[{"id":"openai/gpt-4o","name":"GPT-4o","context_length":128000}]}
        "openrouter" => {
            let arr = json["data"].as_array().ok_or("missing data array")?;
            arr.iter().filter_map(|m| {
                let id = m["id"].as_str()?.to_string();
                let name = m["name"].as_str().unwrap_or(&id).to_string();
                Some(ModelInfo { id, name })
            }).collect()
        }

        // ── OpenAI + DeepSeek + Grok + NVIDIA NIM (OpenAI-compatible /v1/models) ─
        // {"data":[{"id":"gpt-4o","object":"model"}]}
        _ => {
            let arr = json["data"].as_array().ok_or("missing data array")?;
            let mut list: Vec<ModelInfo> = arr.iter().filter_map(|m| {
                let id = m["id"].as_str()?.to_string();
                let name = m["name"].as_str()
                    .or_else(|| m["display_name"].as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| id.clone());
                Some(ModelInfo { id, name })
            }).collect();

            // For OpenAI, filter down to chat-capable models only
            if provider == "openai" {
                list.retain(|m| openai_is_chat_model(&m.id));
                // Sort: newest first (by rough version heuristic)
                list.sort_by(|a, b| b.id.cmp(&a.id));
            }

            // For NVIDIA NIM, filter to chat/language models only (skip reranking, embedding, etc.)
            if provider == "nvidia" {
                list.retain(|m| {
                    let id = m.id.to_lowercase();
                    !id.contains("embed") && !id.contains("rerank") && !id.contains("clip")
                });
                list.sort_by(|a, b| a.id.cmp(&b.id));
            }

            list
        }
    };

    // Deduplicate by id
    let mut seen = std::collections::HashSet::new();
    models.retain(|m| seen.insert(m.id.clone()));

    Ok(models)
}

/// Fetch the list of available models for a cloud provider.
/// The API key is retrieved directly from the OS keychain — never exposed to the frontend.
#[tauri::command]
async fn fetch_provider_models(provider: String) -> Result<Vec<ModelInfo>, String> {
    let key = keychain_get(&provider)
        .ok_or_else(|| format!("No API key stored for '{}'", provider))?;

    let body = match provider.as_str() {
        "openai" => authed_get(
            "https://api.openai.com/v1/models",
            &[("Authorization", &format!("Bearer {}", key))],
        ).await?,

        "anthropic" => authed_get(
            "https://api.anthropic.com/v1/models?limit=100",
            &[
                ("x-api-key", &key),
                ("anthropic-version", "2023-06-01"),
            ],
        ).await?,

        "deepseek" => authed_get(
            "https://api.deepseek.com/models",
            &[("Authorization", &format!("Bearer {}", key))],
        ).await?,

        "mistral" => authed_get(
            "https://api.mistral.ai/v1/models",
            &[("Authorization", &format!("Bearer {}", key))],
        ).await?,

        "google" => {
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models?key={}&pageSize=100",
                key
            );
            authed_get(&url, &[]).await?
        }

        "grok" => authed_get(
            "https://api.x.ai/v1/models",
            &[("Authorization", &format!("Bearer {}", key))],
        ).await?,

        "together" => authed_get(
            "https://api.together.xyz/v1/models",
            &[("Authorization", &format!("Bearer {}", key))],
        ).await?,

        "openrouter" => authed_get(
            "https://openrouter.ai/api/v1/models",
            &[("Authorization", &format!("Bearer {}", key))],
        ).await?,

        // Ollama Cloud (ollama.com hosted service) — same /api/tags format as local Ollama
        "ollama_cloud" => authed_get(
            "https://ollama.com/api/tags",
            &[("Authorization", &format!("Bearer {}", key))],
        ).await?,

        // NVIDIA NIM — OpenAI-compatible /v1/models endpoint
        "nvidia" => authed_get(
            "https://integrate.api.nvidia.com/v1/models",
            &[("Authorization", &format!("Bearer {}", key))],
        ).await?,

        other => return Err(format!("Unsupported provider: '{}'", other)),
    };

    parse_models(&body, &provider)
}

// ─── OS Keychain storage ───────────────────────────────────────────────────────
//
// Security model:
//   • API keys are stored exclusively in the OS-native credential store:
//       Windows  — Windows Credential Manager (DPAPI-encrypted, user-scoped)
//       macOS    — macOS Keychain Services
//       Linux    — FreeDesktop Secret Service (gnome-keyring / kwallet)
//   • The config.json file on disk NEVER contains actual key material.
//   • This is the same approach used by Anthropic's Claude Code CLI, GitHub CLI,
//     VS Code, and other professional desktop tools.

const KEYCHAIN_SERVICE: &str = "integraded";

/// All cloud provider IDs known to the application.
const KNOWN_PROVIDERS: &[&str] = &[
    "openai", "anthropic", "deepseek", "mistral",
    "google", "grok", "together", "openrouter", "ollama_cloud", "nvidia",
];

/// Store a secret in the OS keychain under service="integraded", account=provider.
fn keychain_set(provider: &str, secret: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, provider)
        .map_err(|e| format!("Keychain init error for '{}': {}", provider, e))?
        .set_password(secret)
        .map_err(|e| format!("Failed to store key for '{}' in OS keychain: {}", provider, e))
}

/// Retrieve a secret from the OS keychain. Returns None if not found.
fn keychain_get(provider: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, provider).ok()?
        .get_password().ok()
}

/// Delete a secret from the OS keychain (silently ignores "not found").
fn keychain_delete(provider: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, provider) {
        let _ = entry.delete_credential();
    }
}

// ─── Legacy decryption (migration only) ───────────────────────────────────────
//
// These functions exist solely to migrate old XOR-obfuscated values from
// config.json into the keychain on first run. They are NOT used for new storage.

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

fn legacy_derive_key(salt: &[u8]) -> [u8; 64] {
    let mut material: Vec<u8> = Vec::new();
    for var in ["USERNAME", "COMPUTERNAME", "USERPROFILE", "USER", "HOSTNAME", "HOME"] {
        if let Ok(val) = std::env::var(var) {
            material.extend_from_slice(val.as_bytes());
            material.push(0x3A);
        }
    }
    if material.is_empty() {
        material.extend_from_slice(b"INTEGRADED_DEFAULT_MACHINE_FALLBACK");
    }
    let mut out = [0u8; 64];
    for i in 0..64usize {
        let mut v: u8 = material[i % material.len()].wrapping_add(salt[i % salt.len()]);
        for round in 0u8..=255 {
            let prev = if i > 0 { out[i - 1] } else { 0xA5u8 };
            let m = material[(i.wrapping_add(round as usize)) % material.len()];
            let s = salt[(i.wrapping_add(round as usize * 3)) % salt.len()];
            v = v.rotate_left(((round % 5) + 1) as u32).wrapping_add(m).wrapping_add(prev) ^ s ^ (round.wrapping_mul(0x6B));
        }
        out[i] = v;
    }
    out
}

/// Attempt to decrypt a legacy XOR-obfuscated key value (v1 or v2 format).
/// Used only during one-time migration to the keychain.
fn legacy_unscramble(hex_str: &str) -> Result<String, String> {
    if let Some(rest) = hex_str.strip_prefix("v2:") {
        let mut parts = rest.splitn(2, ':');
        let salt_hex = parts.next().ok_or("Missing salt")?;
        let cipher_hex = parts.next().ok_or("Missing cipher")?;
        let salt = hex_to_bytes(salt_hex)?;
        let cipher = hex_to_bytes(cipher_hex)?;
        let key = legacy_derive_key(&salt);
        let plain: Vec<u8> = cipher.iter().enumerate().map(|(i, &b)| b ^ key[i % key.len()]).collect();
        String::from_utf8(plain).map_err(|e| format!("Invalid UTF-8: {}", e))
    } else {
        // v1 format
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
        let plain: Vec<u8> = cipher.iter().enumerate().map(|(i, &b)| b ^ key[i % key.len()]).collect();
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
fn save_config(config: AppConfig) -> Result<(), String> {
    let path = get_config_path()?;

    // ── Persist API keys in the OS keychain, NOT in the config file ───────────
    for (provider, key_val) in &config.api_keys {
        if key_val == "••••••••••••••••" {
            // Unchanged masked placeholder — keychain entry already correct; do nothing.
        } else if key_val.is_empty() {
            // User explicitly cleared this key — remove it from the keychain.
            keychain_delete(provider);
        } else {
            // New or updated plaintext key — store in OS keychain.
            keychain_set(provider, key_val)?;
        }
    }

    // Build a sanitized copy without any key material for the config file.
    let mut file_config = config;
    for val in file_config.api_keys.values_mut() {
        *val = String::new();
    }

    let json = serde_json::to_string_pretty(&file_config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(path, json).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

#[tauri::command]
fn load_config() -> Result<AppConfig, String> {
    let path = get_config_path()?;

    let mut config = if !path.exists() {
        AppConfig::default()
    } else {
        let json = fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {}", e))?;
        serde_json::from_str::<AppConfig>(&json)
            .map_err(|e| format!("Failed to parse config: {}", e))?
    };

    // ── One-time migration: decrypt old XOR-obfuscated keys → keychain ────────
    let mut needs_resave = false;
    for (provider, val) in config.api_keys.iter_mut() {
        if val.is_empty() { continue; }
        // Any non-empty value in the file is a legacy encrypted key.
        // Try to decrypt it and move it into the keychain.
        match legacy_unscramble(val) {
            Ok(plaintext) if !plaintext.is_empty() => {
                // Only migrate if the keychain doesn't already have a value.
                if keychain_get(provider).is_none() {
                    let _ = keychain_set(provider, &plaintext);
                }
            }
            _ => {} // Unreadable — ignore; user will need to re-enter the key.
        }
        *val = String::new();
        needs_resave = true;
    }
    if needs_resave {
        // Rewrite config.json without legacy key material.
        if let Ok(json) = serde_json::to_string_pretty(&config) {
            let _ = fs::write(&path, json);
        }
    }

    // ── Populate api_keys with masked markers for every provider in keychain ──
    // The frontend uses these markers to know a key is set (e.g. to show the
    // model picker) without ever receiving the actual key value.
    for &provider in KNOWN_PROVIDERS {
        if keychain_get(provider).is_some() {
            config.api_keys.insert(provider.to_string(), "••••••••••••••••".to_string());
        }
    }

    Ok(config)
}

/// Persist the active model and provider selection without touching API keys.
#[tauri::command]
fn save_active_model(model: String, provider: String) -> Result<(), String> {
    let path = get_config_path()?;
    let mut config = if path.exists() {
        let json = fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
        serde_json::from_str::<AppConfig>(&json).unwrap_or_default()
    } else {
        AppConfig::default()
    };
    config.active_model = model;
    config.cloud_provider = provider;
    // Clear key values before writing to disk
    for v in config.api_keys.values_mut() { *v = String::new(); }
    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(path, json).map_err(|e| format!("Write error: {}", e))
}

/// Toggle a provider on or off (disabled providers' models are hidden from the picker).
#[tauri::command]
fn set_provider_enabled(provider: String, enabled: bool) -> Result<(), String> {
    let path = get_config_path()?;
    let mut config = if path.exists() {
        let json = fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
        serde_json::from_str::<AppConfig>(&json).unwrap_or_default()
    } else {
        AppConfig::default()
    };
    if enabled {
        config.disabled_providers.retain(|p| p != &provider);
    } else if !config.disabled_providers.contains(&provider) {
        config.disabled_providers.push(provider);
    }
    for v in config.api_keys.values_mut() { *v = String::new(); }
    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(path, json).map_err(|e| format!("Write error: {}", e))
}

/// Retrieve the plaintext API key for a provider from the OS keychain.
/// Called by the frontend immediately before making an outbound API request.
/// Tauri commands are only callable from the app's own sandboxed webview.
#[tauri::command]
fn get_api_key(provider: String) -> Result<String, String> {
    keychain_get(&provider)
        .ok_or_else(|| format!("No API key stored for provider '{}'. Please add it in Settings.", provider))
}

// ─── Outbound Destination Whitelisting (SSRF Mitigation) ──────────────────────
fn validate_url(url: &str) -> Result<(), String> {
    // Parse the URL properly to extract scheme + host, preventing bypasses like
    // http://localhost:80@evil.com/ which starts_with checks would miss.
    let parsed = url.parse::<tauri::Url>()
        .map_err(|_| "Access Denied: Malformed URL.".to_string())?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Access Denied: Only HTTP and HTTPS protocol endpoints are allowed.".to_string());
    }

    // Reject any URL that has credentials (user@host) — used in bypass attacks.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Access Denied: URLs with credentials are not allowed.".to_string());
    }

    let host = parsed.host_str().unwrap_or("").to_lowercase();
    let port = parsed.port();

    // Local providers: http(s) allowed for loopback addresses.
    let is_local = (scheme == "http" || scheme == "https")
        && (host == "localhost" || host == "127.0.0.1" || host == "::1");
    let _ = port; // port is unrestricted for local

    // Whitelisted cloud API hosts (https only).
    let allowed_https_hosts = [
        "api.openai.com",
        "api.anthropic.com",
        "api.deepseek.com",
        "api.mistral.ai",
        "generativelanguage.googleapis.com",
        "api.x.ai",
        "api.together.xyz",
        "openrouter.ai",
        "ollama.com",
        "integrate.api.nvidia.com",
        "skills.sh",
        "www.skills.sh",
        "raw.githubusercontent.com",
        "api.github.com",
    ];
    let is_cloud = scheme == "https" && allowed_https_hosts.iter().any(|&h| host == h);

    if is_local || is_cloud {
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
            .args(&["-s", &url])
            .output(),
    )
    .await
    .map_err(|_| "Request timed out after 30 seconds.".to_string())?
    .map_err(|e| format!("Failed to execute curl: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8(output.stdout)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
    } else {
        Err(format!("curl error: {}", String::from_utf8_lossy(&output.stderr)))
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
    
    let app_clone = app.clone();
    // Pre-compute event names to avoid a heap allocation on every streamed token.
    let chunk_event = format!("stream-chunk-{}", session_id);
    let done_event  = format!("stream-done-{}", session_id);

    loop {
        let timeout_result = tokio::time::timeout(
            std::time::Duration::from_secs(300),
            lines.next_line(),
        ).await;

        match timeout_result {
            Ok(Ok(Some(line))) => {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    // Emit &str directly — no extra String allocation per token.
                    let _ = app_clone.emit(&chunk_event, trimmed);
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
    let _ = app.emit(&done_event, ());
    
    // Wait for curl to finish (ignore errors – we already got the data)
    let _ = child.wait().await;
    
    Ok(())
}

// ─── Skills system ────────────────────────────────────────────────────────────
//
// Skills are reusable AI agent capabilities from skills.sh.
// Installed skills are stored under ~/.integraded-workspace/skills/{safe-id}/
// and contain SKILL.md plus optional supporting files.

const SKILLS_DIR: &str = ".integraded-workspace/skills";
const SKILLS_BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// Scrape the description from a skills.sh skill page HTML.
/// Extracts it from <meta name="description" content="..."> since the API requires auth.
async fn scrape_skills_sh_description(skill_id: &str) -> Option<String> {
    let url = format!("https://www.skills.sh/{}", skill_id);
    if validate_url(&url).is_err() { return None; }
    let mut cmd = tokio::process::Command::new("curl");
    cmd.args([
        "-s", "-L", "--max-time", "15",
        "-H", &format!("User-Agent: {}", SKILLS_BROWSER_UA),
        "-H", "Accept: text/html",
        &url,
    ]);
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output())
        .await.ok()?.ok()?;
    let html = String::from_utf8_lossy(&out.stdout).into_owned();
    // Extract from <meta name="description" content="..."> or og:description
    for pattern in &[
        r#"name="description" content=""#,
        r#"property="og:description" content=""#,
    ] {
        if let Some(start) = html.find(pattern) {
            let after = &html[start + pattern.len()..];
            if let Some(end) = after.find('"') {
                let raw = &after[..end];
                // Decode basic HTML entities
                let decoded = raw
                    .replace("&amp;", "&")
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&quot;", "\"")
                    .replace("&#39;", "'")
                    .replace("&hellip;", "...")
                    .replace("…", "...");
                let trimmed = decoded.trim_end_matches("…").trim_end_matches("...").trim().to_string();
                if !trimmed.is_empty() {
                    return Some(trimmed);
                }
            }
        }
    }
    None
}

/// Metadata saved to meta.json alongside the SKILL.md on disk.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InstalledSkill {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub source: String,
    pub installs: u64,
    pub description: String,
    pub triggers: Vec<String>,
    pub skill_md: String,
    pub installed_at: u64,
}

fn skills_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| format!("Cannot resolve home: {}", e))?;
    let dir = home.join(SKILLS_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create skills dir: {}", e))?;
    Ok(dir)
}

/// Convert a skill id like "owner/repo/slug" to a safe directory name.
/// Each component is sanitized to alphanumeric + hyphen/underscore, then joined
/// with "--" so that path traversal via ".." or absolute paths is impossible.
fn skill_id_to_dir(id: &str) -> String {
    id.split('/')
        .map(|part| {
            let safe: String = part
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
                .collect();
            safe.trim_matches('_').to_string()
        })
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("--")
}

/// Parse frontmatter from SKILL.md to extract description and triggers.
fn parse_skill_md(content: &str) -> (String, Vec<String>) {
    // Find YAML frontmatter between first pair of "---" delimiters
    let stripped = content.trim_start_matches('\n');
    if !stripped.starts_with("---") {
        return (String::new(), Vec::new());
    }
    let after_open = &stripped[3..];
    let end = match after_open.find("\n---") {
        Some(pos) => pos,
        None => return (String::new(), Vec::new()),
    };
    let fm = &after_open[..end];

    // description: single line value
    let description = fm.lines()
        .find_map(|l| l.strip_prefix("description:").map(|v| v.trim().trim_matches('"').trim_matches('\'').to_string()))
        .unwrap_or_default();

    // triggers: YAML block list or inline array
    let mut triggers: Vec<String> = Vec::new();
    let mut in_triggers = false;
    for line in fm.lines() {
        if line.starts_with("triggers:") {
            let rest = line["triggers:".len()..].trim();
            if rest.starts_with('[') {
                // inline: triggers: [react, frontend, css]
                triggers = rest.trim_matches(|c| c == '[' || c == ']')
                    .split(',')
                    .map(|t| t.trim().trim_matches('"').trim_matches('\'').to_string())
                    .filter(|t| !t.is_empty())
                    .collect();
                in_triggers = false;
            } else {
                in_triggers = true;
            }
            continue;
        }
        if in_triggers {
            if line.starts_with(' ') || line.starts_with('\t') {
                let item = line.trim().trim_start_matches('-').trim();
                if !item.is_empty() {
                    triggers.push(item.trim_matches('"').trim_matches('\'').to_string());
                }
            } else {
                in_triggers = false;
            }
        }
    }

    (description, triggers)
}

/// Returns current unix timestamp in seconds.
fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// List all installed skills from ~/.integraded-workspace/skills/.
#[tauri::command]
fn skills_list_installed(app: AppHandle) -> Result<Vec<InstalledSkill>, String> {
    let dir = skills_dir(&app)?;
    let mut skills = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Cannot read skills dir: {}", e))?;
    for entry in entries.flatten() {
        let meta_path = entry.path().join("meta.json");
        if meta_path.exists() {
            if let Ok(content) = fs::read_to_string(&meta_path) {
                if let Ok(skill) = serde_json::from_str::<InstalledSkill>(&content) {
                    skills.push(skill);
                }
            }
        }
    }
    skills.sort_by(|a, b| b.installed_at.cmp(&a.installed_at));
    Ok(skills)
}

/// Download and install a skill from GitHub raw URLs (bypasses rate-limited API).
#[tauri::command]
async fn skill_install(
    skill_id: String,
    skill_name: String,
    source: String,
    installs: u64,
    app: AppHandle,
) -> Result<InstalledSkill, String> {
    let (owner, repo, slug) = {
        let parts: Vec<&str> = skill_id.split('/').collect();
        if parts.len() != 3 {
            return Err("Invalid skill ID format. Expected owner/repo/slug".to_string());
        }
        (parts[0].to_string(), parts[1].to_string(), parts[2].to_string())
    };

    let dir = skills_dir(&app)?;
    let safe_id = skill_id_to_dir(&skill_id);
    let skill_dir = dir.join(&safe_id);
    fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Cannot create skill directory: {}", e))?;

    let mut skill_md = String::new();

    // Candidate raw URLs — try subdirectory format first, then root fallback
    let candidate_urls = vec![
        format!("https://raw.githubusercontent.com/{}/{}/main/skills/{}/SKILL.md", owner, repo, slug),
        format!("https://raw.githubusercontent.com/{}/{}/master/skills/{}/SKILL.md", owner, repo, slug),
        format!("https://raw.githubusercontent.com/{}/{}/main/SKILL.md", owner, repo),
        format!("https://raw.githubusercontent.com/{}/{}/master/SKILL.md", owner, repo),
    ];

    let mut found = false;
    for url in &candidate_urls {
        if validate_url(url).is_err() { continue; }
        let mut cmd = tokio::process::Command::new("curl");
        cmd.args([
            "-s", "-L", "--max-time", "15",
            "-H", &format!("User-Agent: {}", SKILLS_BROWSER_UA),
            url,
        ]);
        if let Ok(Ok(out)) = tokio::time::timeout(
            std::time::Duration::from_secs(20), cmd.output()
        ).await {
            let body = String::from_utf8_lossy(&out.stdout).into_owned();
            if !body.trim().is_empty()
                && !body.contains("404: Not Found")
                && !body.starts_with('{')
                && body.contains("---")
            {
                skill_md = body.clone();
                let full_path = skill_dir.join("SKILL.md");
                let _ = fs::write(&full_path, body.as_bytes());
                found = true;
                break;
            }
        }
    }

    if !found {
        return Err(format!(
            "Could not download SKILL.md for \"{}\". The skill may have been removed or its GitHub repository has a non-standard structure.",
            slug
        ));
    }

    // Try to also fetch supporting files from the same directory via GitHub tree API
    // (best-effort only — failure here does NOT block installation)
    let branch_candidates = ["main", "master"];
    let subdir = if candidate_urls[0].contains("/skills/") {
        format!("skills/{}", slug)
    } else {
        String::new()
    };
    'outer: for branch in &branch_candidates {
        let tree_url = format!(
            "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=0",
            owner, repo, branch
        );
        if let Ok(body) = github_get(&tree_url, "application/vnd.github+json").await {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&body) {
                if let Some(tree) = data["tree"].as_array() {
                    for item in tree {
                        if item["type"].as_str() != Some("blob") { continue; }
                        let path = item["path"].as_str().unwrap_or("");
                        // Only download files from the same skill's directory (not SKILL.md — already done)
                        let in_subdir = !subdir.is_empty() && path.starts_with(&format!("{}/", subdir));
                        let is_root = subdir.is_empty() && !path.contains('/');
                        if (in_subdir || is_root) && !path.ends_with("SKILL.md") {
                            let file_name = path.rsplit('/').next().unwrap_or(path);
                            let raw_url = format!(
                                "https://raw.githubusercontent.com/{}/{}/{}/{}",
                                owner, repo, branch, path
                            );
                            if let Ok(Ok(out)) = tokio::time::timeout(
                                std::time::Duration::from_secs(10),
                                tokio::process::Command::new("curl")
                                    .args(["-s", "-L", "--max-time", "10",
                                           "-H", &format!("User-Agent: {}", SKILLS_BROWSER_UA),
                                           &raw_url])
                                    .output()
                            ).await {
                                let content = String::from_utf8_lossy(&out.stdout).into_owned();
                                if !content.is_empty() {
                                    let _ = fs::write(skill_dir.join(file_name), content.as_bytes());
                                }
                            }
                        }
                    }
                    break 'outer;
                }
            }
        }
    }

    // Get description from SKILL.md frontmatter; if empty, try skills.sh page
    let (mut description, triggers) = parse_skill_md(&skill_md);
    if description.is_empty() {
        if let Some(desc) = scrape_skills_sh_description(&skill_id).await {
            description = desc;
        }
    }

    let installed = InstalledSkill {
        id: skill_id,
        slug: slug.to_string(),
        name: skill_name,
        source,
        installs,
        description,
        triggers,
        skill_md,
        installed_at: unix_now(),
    };

    // Save metadata
    let meta_json = serde_json::to_string_pretty(&installed)
        .map_err(|e| format!("Cannot serialize skill metadata: {}", e))?;
    fs::write(skill_dir.join("meta.json"), meta_json.as_bytes())
        .map_err(|e| format!("Cannot write skill metadata: {}", e))?;

    Ok(installed)
}

/// Uninstall a skill — removes its directory from ~/.integraded-workspace/skills/.
#[tauri::command]
fn skill_uninstall(skill_id: String, app: AppHandle) -> Result<(), String> {
    let dir = skills_dir(&app)?;
    let skill_dir = dir.join(skill_id_to_dir(&skill_id));
    if skill_dir.exists() {
        fs::remove_dir_all(&skill_dir)
            .map_err(|e| format!("Failed to remove skill: {}", e))?;
    }
    Ok(())
}

/// Read SKILL.md content for a specific installed skill (for terminal injection).
#[tauri::command]
fn skill_read_content(skill_id: String, app: AppHandle) -> Result<String, String> {
    let dir = skills_dir(&app)?;
    let skill_md = dir.join(skill_id_to_dir(&skill_id)).join("SKILL.md");
    fs::read_to_string(&skill_md).map_err(|e| format!("Cannot read SKILL.md: {}", e))
}

/// Write a skill file into the workspace's .integraded-skills/ directory.
/// Creates the directory automatically. Returns the written file path.
/// Slug is sanitized to prevent path traversal — only [a-zA-Z0-9_-] allowed.
#[tauri::command]
fn write_skill_to_workspace(
    workspace_dir: String,
    slug: String,
    content: String,
    state: State<'_, WorkspaceState>,
) -> Result<String, String> {
    let roots = workspace_roots(&state)?;
    // Validate workspace_dir itself is inside an active workspace
    validate_in_workspace(&workspace_dir, &roots)?;

    // Sanitize slug: only alphanumeric + hyphen/underscore, strip leading/trailing underscores
    let safe_slug: String = slug
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let safe_slug = safe_slug.trim_matches('_');
    if safe_slug.is_empty() {
        return Err("Invalid skill slug: must contain alphanumeric characters.".to_string());
    }

    let ws_path = Path::new(&workspace_dir);
    let skills_subdir = ws_path.join(".integraded-skills");
    fs::create_dir_all(&skills_subdir)
        .map_err(|e| format!("Cannot create .integraded-skills/ directory: {}", e))?;

    let file_path = skills_subdir.join(format!("{}.md", safe_slug));
    fs::write(&file_path, content.as_bytes())
        .map_err(|e| format!("Cannot write skill file: {}", e))?;

    Ok(file_path.to_string_lossy().into_owned())
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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SubProjectInfo {
    pub dir: String,
    pub name: String,
    pub project: DevProjectInfo,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// List immediate children of `dir` (no recursion) for the in-app file browser.
/// Skips hidden dirs and build artifacts, shows files too.
#[tauri::command]
fn list_dir_shallow(dir: String) -> Vec<DirEntry> {
    let path = Path::new(&dir);
    let blocked: &[&str] = &[
        "node_modules", "target", "dist", "build", ".git",
        ".next", ".nuxt", "__pycache__", ".svelte-kit",
    ];
    let Ok(entries) = fs::read_dir(path) else { return Vec::new(); };
    let mut items: Vec<DirEntry> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.path().is_dir();
            if is_dir && (name.starts_with('.') || blocked.contains(&name.as_str())) {
                return None;
            }
            Some(DirEntry { name, path: e.path().to_string_lossy().to_string(), is_dir })
        })
        .collect();
    items.sort_by(|a, b| {
        if a.is_dir != b.is_dir { b.is_dir.cmp(&a.is_dir) }
        else { a.name.to_lowercase().cmp(&b.name.to_lowercase()) }
    });
    items
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

        // ── Package manager: check lockfiles AND packageManager field ────────
        // Also check node_modules/.modules.yaml which pnpm always writes,
        // and .yarn/releases which Yarn Berry writes — these survive in
        // sub-project directories that may not have their own lockfile.
        let pm_field = pkg.get("packageManager")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let pm = if path.join("bun.lockb").exists() || path.join("bun.lock").exists()
            || pm_field.starts_with("bun")
        {
            "bun"
        } else if path.join("pnpm-lock.yaml").exists()
            || path.join("pnpm-workspace.yaml").exists()
            || path.join("node_modules").join(".modules.yaml").exists()
            || pm_field.starts_with("pnpm")
        {
            "pnpm"
        } else if path.join("yarn.lock").exists()
            || path.join(".yarn").join("releases").is_dir()
            || pm_field.starts_with("yarn")
        {
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

        // ── Port heuristics ──────────────────────────────────────────────────
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
        } else if has_dep("astro") {
            4321
        } else if has_dep("@remix-run/dev") || has_dep("@remix-run/react") {
            3000
        } else {
            3000
        };

        // ── Script selection ─────────────────────────────────────────────────
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

        // ── Command construction ─────────────────────────────────────────────
        // npm requires "run" sub-command; pnpm/yarn/bun accept script name directly.
        let command = if pm == "npm" {
            format!("npm run {}", script)
        } else {
            format!("{} run {}", pm, script)
        };

        return Ok(DevProjectInfo {
            project_type: "node".to_string(),
            label: format!("{} run {} :{}", pm, script, port),
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
            label: "npx vite :5173".to_string(),
            command: "npx vite".to_string(),
            port: 5173,
            package_manager: "npx".to_string(),
        });
    }

    // ── Static HTML (no package.json) ──────────────────────────────────────
    if path.join("index.html").exists() {
        return Ok(DevProjectInfo {
            project_type: "static".to_string(),
            label: "serve :3000".to_string(),
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

/// Scan one level of subdirectories and return those that contain a recognisable project.
#[tauri::command]
fn list_sub_projects(dir: String) -> Vec<SubProjectInfo> {
    let path = Path::new(&dir);
    let mut results = Vec::new();

    let Ok(entries) = fs::read_dir(path) else { return results; };
    let mut dirs: Vec<_> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .collect();
    dirs.sort_by_key(|e| e.file_name());

    for entry in dirs {
        let sub = entry.path();
        let name = sub.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        // Skip dot-dirs and build artifacts
        if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "dist" | ".git" | "__pycache__") {
            continue;
        }
        let sub_str = sub.to_string_lossy().to_string();
        if let Ok(project) = detect_dev_project(sub_str.clone()) {
            results.push(SubProjectInfo { dir: sub_str, name, project });
        }
    }
    results
}

/// Extend PATH with common Node.js binary locations so npm/pnpm/yarn/bun
/// are found even when the Tauri app was launched from a GUI shortcut or
/// file manager (which gives a minimal environment without shell rc files).
fn node_extended_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();

    #[cfg(target_os = "windows")]
    {
        let appdata  = std::env::var("APPDATA").unwrap_or_default();
        let local    = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let profile  = std::env::var("USERPROFILE").unwrap_or_default();
        let extras = [
            format!("{local}\\pnpm"),                     // pnpm (modern)
            format!("{appdata}\\npm"),                    // npm global
            format!("{profile}\\.bun\\bin"),              // bun
            format!("{profile}\\.volta\\bin"),            // volta
            format!("{local}\\Volta\\bin"),               // volta (alt)
            "C:\\Program Files\\nodejs".to_string(),
            "C:\\Program Files (x86)\\nodejs".to_string(),
        ];
        let extra: Vec<&str> = extras.iter()
            .filter(|p| Path::new(p.as_str()).exists())
            .map(|p| p.as_str())
            .collect();
        if extra.is_empty() { return base; }
        format!("{};{}", extra.join(";"), base)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let extras = [
            format!("{home}/.bun/bin"),
            format!("{home}/.volta/bin"),
            format!("{home}/.nvm/versions/node/current/bin"),
            "/usr/local/bin".to_string(),
            "/opt/homebrew/bin".to_string(),    // macOS Apple Silicon
        ];
        let extra: Vec<&str> = extras.iter()
            .filter(|p| Path::new(p.as_str()).exists())
            .map(|p| p.as_str())
            .collect();
        if extra.is_empty() { return base; }
        format!("{}:{}", extra.join(":"), base)
    }
}

/// Start the dev server as a detached background process.
#[tauri::command]
fn start_dev_server_background(dir: String, command: String, state: State<'_, DevServerState>) -> Result<(), String> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("cmd.exe");
        c.args(["/c", &command]);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    // Ensure Node.js package managers are discoverable even from a GUI launch.
    cmd.env("PATH", node_extended_path());
    if !dir.is_empty() && Path::new(&dir).exists() {
        cmd.current_dir(&dir);
    }
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    cmd.stdin(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| format!("Failed to start dev server in background: {}", e))?;
    let pid = child.id();
    std::mem::forget(child);
    let mut guard = state.0.lock().map_err(|e| format!("Mutex poisoned: {}", e))?;
    *guard = Some(pid);
    Ok(())
}

#[tauri::command]
fn stop_dev_server_background(port: u16, state: State<'_, DevServerState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| format!("Mutex poisoned: {}", e))?;
    if let Some(pid) = guard.take() {
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd.exe")
            .args(["/c", &format!(
                "for /f \"tokens=5\" %a in ('netstat -ano ^| findstr :{port} ^| findstr LISTENING') do taskkill /F /PID %a"
            )])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("sh")
            .args(["-c", &format!("fuser -k {}/tcp 2>/dev/null || lsof -ti:{} | xargs -r kill -9", port, port)])
            .spawn();
    }
    Ok(())
}

#[tauri::command]
fn check_port_open(port: u16) -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    if TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(200),
    ).is_ok() {
        return true;
    }
    TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
        Duration::from_millis(200),
    ).is_ok()
}

// ─── Skills system (GitHub extensions) ─────────────────────────────────────────

/// Fetch JSON from a URL with optional headers (used for GitHub API / raw content).
async fn github_get(url: &str, accept: &str) -> Result<String, String> {
    validate_url(url)?;
    let mut cmd = tokio::process::Command::new("curl");
    cmd.args([
        "-s", "-L", "--max-time", "15",
        "-H", &format!("Accept: {}", accept),
        "-H", "User-Agent: Integraded-App/1.0",
        url,
    ]);
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output())
        .await
        .map_err(|_| "GitHub request timed out".to_string())?
        .map_err(|e| format!("curl error: {}", e))?;
    let body = String::from_utf8_lossy(&out.stdout).into_owned();
    if body.trim().is_empty() {
        return Err(format!("Empty GitHub response: {}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(body)
}

/// Scrape install count from formatted strings like "1.8M", "479.2K", "123".
fn parse_installs_str(s: &str) -> u64 {
    let s = s.trim();
    if let Some(n) = s.strip_suffix('M') {
        return (n.parse::<f64>().unwrap_or(0.0) * 1_000_000.0) as u64;
    }
    if let Some(n) = s.strip_suffix('K') {
        return (n.parse::<f64>().unwrap_or(0.0) * 1_000.0) as u64;
    }
    s.parse().unwrap_or(0)
}

/// List/search skills by scraping the public skills.sh website (no API key required).
/// query = "" → fetch the leaderboard; query ≥ 2 chars → filter results.
#[tauri::command]
async fn skills_fetch_list(query: String, page: u32) -> Result<String, String> {
    // Scrape the skills.sh homepage which is server-side rendered
    let url = "https://www.skills.sh/";
    let mut cmd = tokio::process::Command::new("curl");
    cmd.args([
        "-s", "-L", "--max-time", "20",
        "-H", &format!("User-Agent: {}", SKILLS_BROWSER_UA),
        "-H", "Accept: text/html",
        url,
    ]);
    let out = tokio::time::timeout(std::time::Duration::from_secs(25), cmd.output())
        .await
        .map_err(|_| "skills.sh request timed out".to_string())?
        .map_err(|e| format!("curl error: {}", e))?;
    let html = String::from_utf8_lossy(&out.stdout).into_owned();

    if html.trim().is_empty() || html.len() < 5000 {
        return Err("skills.sh returned an empty or unexpected response".to_string());
    }

    // Parse skill cards: <a href="/owner/repo/slug">...<h3>name</h3><p>source</p>...<span>installs</span>
    // The homepage uses SSR so the data is embedded in the static HTML.
    let mut skills: Vec<serde_json::Value> = Vec::new();
    let q = query.trim().to_lowercase();
    let per_page: usize = 50;
    let offset = page as usize * per_page;

    // Use a simple state-machine parser to extract skill cards from HTML
    // Pattern: href="/owner/repo/slug" → h3 → p (source) → span with digits
    let sections = html.split("class=\"h-[72px] lg:h-[56px]\"").skip(1);
    for section in sections {
        // Extract href
        let href = {
            let start = match section.find("href=\"/") {
                Some(i) => i + 6,  // points to '/'
                None => continue,
            };
            let rest = &section[start..];
            let end = match rest.find('"') {
                Some(i) => i,
                None => continue,
            };
            let path = &rest[..end]; // e.g. "/owner/repo/slug"
            // Must have exactly 3 path segments (owner/repo/slug)
            let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
            if segs.len() != 3 { continue; }
            // Skip navigation paths
            let owner = segs[0];
            if ["agents", "_next", "api", "docs", "topic", "agent", "trending",
                "hot", "official", "audits", "about", "contact", "privacy",
                "terms", "search", "favicon", "og"].contains(&owner) {
                continue;
            }
            path.trim_start_matches('/').to_string() // "owner/repo/slug"
        };

        let segs: Vec<&str> = href.split('/').collect();
        let owner = segs[0];
        let repo  = segs[1];
        let slug  = segs[2];

        // Extract skill name from <h3>
        let name = {
            let start = match section.find("<h3 ") {
                Some(i) => i,
                None => continue,
            };
            let inner = &section[start..];
            let content_start = match inner.find('>') {
                Some(i) => i + 1,
                None => continue,
            };
            let content_end = match inner[content_start..].find("</h3>") {
                Some(i) => content_start + i,
                None => continue,
            };
            inner[content_start..content_end].trim().to_string()
        };

        // Extract source (<p> right after h3)
        let source = format!("{}/{}", owner, repo);

        // Extract install count from <span class="font-mono text-sm text-foreground">
        let installs = {
            let marker = "font-mono text-sm text-foreground\">";
            if let Some(pos) = section.rfind(marker) {
                let rest = &section[pos + marker.len()..];
                let end = rest.find('<').unwrap_or(rest.len());
                parse_installs_str(&rest[..end])
            } else {
                0u64
            }
        };

        // Apply query filter
        if !q.is_empty() && q.len() >= 2 {
            let haystack = format!("{} {} {}", name, slug, source).to_lowercase();
            if !haystack.contains(&q) { continue; }
        }

        skills.push(serde_json::json!({
            "id": href,              // "owner/repo/slug"
            "slug": slug,
            "name": name,
            "source": source,
            "installs": installs,
            "description": ""        // loaded lazily on expand
        }));
    }

    let total = skills.len();
    // Paginate
    let page_items: Vec<serde_json::Value> = skills.into_iter().skip(offset).take(per_page).collect();
    let has_more = offset + per_page < total;

    let response = serde_json::json!({
        "data": page_items,
        "pagination": {
            "page": page,
            "perPage": per_page,
            "total": total,
            "hasMore": has_more
        }
    });
    Ok(response.to_string())
}

// ─── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .manage(WorkspaceState::default())
        .manage(StreamState::default())
        .manage(DevServerState::default())
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
            move_item,
            paste_external_file,
            list_files_meta,
            run_command_in_dir,
            reveal_in_explorer,
            get_clipboard_file_paths,
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
            get_api_key,
            save_active_model,
            set_provider_enabled,
            fetch_provider_models,
            skills_fetch_list,
            skills_list_installed,
            skill_install,
            skill_uninstall,
            skill_read_content,
            write_skill_to_workspace,
            curl_get,
            curl_post,
            curl_post_stream,
            cancel_stream,
            detect_dev_project,
            list_sub_projects,
            list_dir_shallow,
            pick_project_folder,
            check_port_open,
            start_dev_server_background,
            stop_dev_server_background,
            save_chat_to_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
