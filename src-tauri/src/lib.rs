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
        let mut sessions = state.0.lock().unwrap();
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
        let mut sessions = state.0.lock().unwrap();
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
    let mut sessions = state.0.lock().unwrap();
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
    let sessions = state.0.lock().unwrap();
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
    let mut sessions = state.0.lock().unwrap();
    sessions.remove(&session_id);
    Ok(())
}

// ─── File system commands ─────────────────────────────────────────────────────

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn select_directory() -> Option<String> {
    let dir = rfd::FileDialog::new()
        .set_title("Select Integraded Workspace Directory")
        .pick_folder();
    dir.map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn list_files(dir_path: &str) -> Result<Vec<FileInfo>, String> {
    let path = Path::new(dir_path);
    if !path.exists() {
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

    read_dir_recursive(path, 0).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file_content(file_path: &str) -> Result<String, String> {
    fs::read_to_string(file_path).map_err(|e| e.to_string())
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

// ─── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .setup(|app| {
            // Set window icon from the bundled icon so it appears correctly
            // in the Windows titlebar and taskbar (especially in dev mode)
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
            list_files,
            read_file_content,
            check_agent_installed,
            pty_create,
            pty_write,
            pty_resize,
            pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
