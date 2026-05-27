import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNotify } from "./Notification";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[] | null;
}

interface SidebarProps {
  directory: string;
  activeFilePath: string | null;
  onFileSelect: (path: string, name: string) => void;
  width: number;
}

export const Sidebar: React.FC<SidebarProps> = ({ directory, activeFilePath, onFileSelect, width }) => {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const prevJson = useRef("");
  const { notifyError } = useNotify();

  // Context Menu State
  const sidebarDropCounter = useRef(0);

  // ── Path helper: normalize to forward slashes ──
  const norm = (p: string) => p.replace(/\\/g, "/");

  // ── Sidebar background drop handler (move files to workspace root) ──
  const handleSidebarDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleSidebarDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    sidebarDropCounter.current++;
    if (sidebarDropCounter.current === 1) {
      e.currentTarget.classList.add("drag-over-folder");
    }
  };

  const handleSidebarDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    sidebarDropCounter.current--;
    if (sidebarDropCounter.current === 0) {
      e.currentTarget.classList.remove("drag-over-folder");
    }
  };

  const handleSidebarDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    sidebarDropCounter.current = 0;
    e.currentTarget.classList.remove("drag-over-folder");

    const srcPath = e.dataTransfer.getData("text/plain") || (window as any).__integradedDragPath;
    if (!srcPath) return;

    const name = srcPath.split(/[\\/]/).pop();
    if (!name) return;

    const normSrc = norm(srcPath);
    const destPath = norm(directory) + "/" + name;
    if (normSrc === destPath) return;

    try {
      await invoke("rename_item", { oldPath: srcPath, newPath: destPath });
      refresh();
    } catch (err) {
      notifyError(`Failed to move: ${err}`);
    }
  };

  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    targetPath: string | null;
    targetName: string | null;
    targetIsDir: boolean;
  }>({
    visible: false,
    x: 0,
    y: 0,
    targetPath: null,
    targetName: null,
    targetIsDir: false,
  });

  const closeMenu = () => setContextMenu(prev => prev.visible ? { ...prev, visible: false } : prev);

  // Sleek Modal Prompt States
  const [showCreatePrompt, setShowCreatePrompt] = useState<{
    visible: boolean;
    type: "file" | "folder";
    parentPath: string | null;
  }>({
    visible: false,
    type: "file",
    parentPath: null,
  });

  const [showRenamePrompt, setShowRenamePrompt] = useState<{
    visible: boolean;
    path: string;
    name: string;
  }>({
    visible: false,
    path: "",
    name: "",
  });

  const [showDeletePrompt, setShowDeletePrompt] = useState<{
    visible: boolean;
    path: string;
    name: string;
    isDir: boolean;
  }>({
    visible: false,
    path: "",
    name: "",
    isDir: false,
  });

  const [inputVal, setInputVal] = useState("");

  const refresh = useCallback(async () => {
    if (!directory) return;
    setError(null);
    try {
      const r = await invoke<FileEntry[]>("list_files", { dirPath: directory });
      const json = JSON.stringify(r);
      if (prevJson.current !== json) {
        prevJson.current = json;
        setFiles(r);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [directory]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!directory) return;
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [refresh, directory]);

  // Global click listeners to close Context Menu
  useEffect(() => {
    const closeMenu = () => {
      setContextMenu(prev => prev.visible ? { ...prev, visible: false } : prev);
    };
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  // Global dragend safety net — clean up any orphaned drag-over-folder classes
  useEffect(() => {
    const cleanup = () => {
      document.querySelectorAll(".drag-over-folder").forEach(elem =>
        elem.classList.remove("drag-over-folder")
      );
    };
    document.addEventListener("dragend", cleanup);
    return () => document.removeEventListener("dragend", cleanup);
  }, []);

  const getTargetDir = (path: string | null, isDir: boolean) => {
    if (!path) return directory;
    if (isDir) return path;
    const parts = path.split(/[\\/]/);
    parts.pop();
    return parts.join("/");
  };

  const handleNodeContextMenu = (e: React.MouseEvent, path: string, name: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      targetPath: path,
      targetName: name,
      targetIsDir: isDir,
    });
  };

  const handleBgContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      targetPath: null,
      targetName: null,
      targetIsDir: false,
    });
  };

  const startCreate = (type: "file" | "folder") => {
    const parent = getTargetDir(contextMenu.targetPath, contextMenu.targetIsDir);
    closeMenu();
    setInputVal("");
    setShowCreatePrompt({
      visible: true,
      type,
      parentPath: parent,
    });
  };

  const startRename = () => {
    if (!contextMenu.targetPath || !contextMenu.targetName) return;
    closeMenu();
    setInputVal(contextMenu.targetName);
    setShowRenamePrompt({
      visible: true,
      path: contextMenu.targetPath,
      name: contextMenu.targetName,
    });
  };

  const startDelete = () => {
    if (!contextMenu.targetPath || !contextMenu.targetName) return;
    closeMenu();
    setShowDeletePrompt({
      visible: true,
      path: contextMenu.targetPath,
      name: contextMenu.targetName,
      isDir: contextMenu.targetIsDir,
    });
  };

  const handleCreateSubmit = async () => {
    if (!inputVal.trim() || !showCreatePrompt.parentPath) return;
    const path = `${showCreatePrompt.parentPath}/${inputVal.trim()}`;
    try {
      if (showCreatePrompt.type === "file") {
        await invoke("create_file", { filePath: path, content: "" });
      } else {
        await invoke("create_dir", { dirPath: path });
      }
      refresh();
    } catch (e) {
      notifyError(`Operation failed: ${e}`);
    } finally {
      setShowCreatePrompt({ visible: false, type: "file", parentPath: null });
      setInputVal("");
    }
  };

  const handleRenameSubmit = async () => {
    if (!inputVal.trim()) return;
    const parts = showRenamePrompt.path.split(/[\\/]/);
    parts.pop();
    parts.push(inputVal.trim());
    const newPath = parts.join("/");
    try {
      await invoke("rename_item", { oldPath: showRenamePrompt.path, newPath });
      refresh();
    } catch (e) {
      notifyError(`Rename failed: ${e}`);
    } finally {
      setShowRenamePrompt({ visible: false, path: "", name: "" });
      setInputVal("");
    }
  };

  const handleDeleteSubmit = async () => {
    try {
      await invoke("delete_item", { path: showDeletePrompt.path });
      refresh();
    } catch (e) {
      notifyError(`Delete failed: ${e}`);
    } finally {
      setShowDeletePrompt({ visible: false, path: "", name: "", isDir: false });
    }
  };

  const handleCopy = () => {
    if (!contextMenu.targetPath || !contextMenu.targetName) return;
    (window as any).__integradedClipboard = {
      srcPath: contextMenu.targetPath,
      name: contextMenu.targetName,
      isDir: contextMenu.targetIsDir,
    };
    closeMenu();
  };

  const handlePaste = async () => {
    const clipboard = (window as any).__integradedClipboard;
    if (!clipboard) return;
    const destDir = getTargetDir(contextMenu.targetPath, contextMenu.targetIsDir);
    const destPath = `${destDir}/${clipboard.name}`;
    try {
      await invoke("copy_item", { srcPath: clipboard.srcPath, destPath });
      refresh();
    } catch (e) {
      notifyError(`Paste failed: ${e}`);
    }
    closeMenu();
  };

  const clipboardActive = !!(window as any).__integradedClipboard;

  return (
    <div
      className="file-sidebar"
      style={{ width }}
      onContextMenu={handleBgContextMenu}
      onDragOver={handleSidebarDragOver}
      onDragEnter={handleSidebarDragEnter}
      onDragLeave={handleSidebarDragLeave}
      onDrop={handleSidebarDrop}
    >
      <div className="sidebar-titlebar">
        <span className="sidebar-titlebar-label">Explorer</span>
      </div>

      <div className="sidebar-scroll">
        {error && (
          <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--err)" }}>{error}</div>
        )}

        {files.map(f => (
          <TreeNode
            key={f.path}
            node={f}
            depth={0}
            activeFilePath={activeFilePath}
            onFileSelect={onFileSelect}
            onNodeContextMenu={handleNodeContextMenu}
            onRefresh={refresh}
          />
        ))}
      </div>

      {/* Floating Context Menu */}
      {contextMenu.visible && (
        <div
          className="sidebar-context-menu"
          style={{
            top: contextMenu.y,
            left: contextMenu.x,
          }}
          onClick={e => e.stopPropagation()}
        >
          <button className="context-menu-item" onClick={() => startCreate("file")}>
            <i className="bx bx-file" /> New File
          </button>
          <button className="context-menu-item" onClick={() => startCreate("folder")}>
            <i className="bx bx-folder" /> New Folder
          </button>
          {contextMenu.targetPath && (
            <>
              <div style={{ height: "1px", background: "var(--bg-4)", margin: "4px 0" }} />
              <button className="context-menu-item" onClick={handleCopy}>
                <i className="bx bx-copy" /> Copy
              </button>
              <button className="context-menu-item" onClick={handlePaste} disabled={!clipboardActive}>
                <i className="bx bx-paste" /> Paste
              </button>
              <div style={{ height: "1px", background: "var(--bg-4)", margin: "4px 0" }} />
              <button className="context-menu-item" onClick={startRename}>
                <i className="bx bx-edit" /> Rename
              </button>
              <button className="context-menu-item danger" onClick={startDelete}>
                <i className="bx bx-trash" /> Delete
              </button>
            </>
          )}
          {!contextMenu.targetPath && clipboardActive && (
            <>
              <div style={{ height: "1px", background: "var(--bg-4)", margin: "4px 0" }} />
              <button className="context-menu-item" onClick={handlePaste}>
                <i className="bx bx-paste" /> Paste
              </button>
            </>
          )}
        </div>
      )}

      {/* Sleek Inline Modal Prompts */}
      {showCreatePrompt.visible && (
        <div
          className="dialog-overlay"
          onClick={() => setShowCreatePrompt({ visible: false, type: "file", parentPath: null })}
        >
          <div className="dialog-box" onClick={e => e.stopPropagation()} style={{ width: "300px" }}>
            <div className="dialog-header">
              <span className="dialog-title">
                Create New {showCreatePrompt.type === "file" ? "File" : "Folder"}
              </span>
              <button
                className="dialog-close"
                onClick={() => setShowCreatePrompt({ visible: false, type: "file", parentPath: null })}
              >
                <i className="bx bx-x" />
              </button>
            </div>
            <div className="dialog-body" style={{ padding: "16px" }}>
              <input
                type="text"
                className="stng-input"
                value={inputVal}
                onChange={e => setInputVal(e.target.value)}
                placeholder={showCreatePrompt.type === "file" ? "newfile.txt" : "new-folder"}
                autoFocus
                style={{ width: "100%", boxSizing: "border-box" }}
                onKeyDown={e => {
                  if (e.key === "Enter") handleCreateSubmit();
                  if (e.key === "Escape") setShowCreatePrompt({ visible: false, type: "file", parentPath: null });
                }}
              />
            </div>
            <div className="dialog-footer" style={{ padding: "12px 16px" }}>
              <button
                className="stng-btn stng-btn-ghost"
                onClick={() => setShowCreatePrompt({ visible: false, type: "file", parentPath: null })}
                style={{ fontSize: "12px" }}
              >
                Cancel
              </button>
              <button
                className="stng-btn stng-btn-primary"
                onClick={handleCreateSubmit}
                disabled={!inputVal.trim()}
                style={{ fontSize: "12px" }}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {showRenamePrompt.visible && (
        <div className="dialog-overlay" onClick={() => setShowRenamePrompt({ visible: false, path: "", name: "" })}>
          <div className="dialog-box" onClick={e => e.stopPropagation()} style={{ width: "300px" }}>
            <div className="dialog-header">
              <span className="dialog-title">Rename Item</span>
              <button
                className="dialog-close"
                onClick={() => setShowRenamePrompt({ visible: false, path: "", name: "" })}
              >
                <i className="bx bx-x" />
              </button>
            </div>
            <div className="dialog-body" style={{ padding: "16px" }}>
              <input
                type="text"
                className="stng-input"
                value={inputVal}
                onChange={e => setInputVal(e.target.value)}
                autoFocus
                style={{ width: "100%", boxSizing: "border-box" }}
                onKeyDown={e => {
                  if (e.key === "Enter") handleRenameSubmit();
                  if (e.key === "Escape") setShowRenamePrompt({ visible: false, path: "", name: "" });
                }}
              />
            </div>
            <div className="dialog-footer" style={{ padding: "12px 16px" }}>
              <button
                className="stng-btn stng-btn-ghost"
                onClick={() => setShowRenamePrompt({ visible: false, path: "", name: "" })}
                style={{ fontSize: "12px" }}
              >
                Cancel
              </button>
              <button
                className="stng-btn stng-btn-primary"
                onClick={handleRenameSubmit}
                disabled={!inputVal.trim() || inputVal.trim() === showRenamePrompt.name}
                style={{ fontSize: "12px" }}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeletePrompt.visible && (
        <div
          className="dialog-overlay"
          onClick={() => setShowDeletePrompt({ visible: false, path: "", name: "", isDir: false })}
        >
          <div
            className="dialog-box"
            onClick={e => e.stopPropagation()}
            style={{ width: "320px" }}
            onKeyDown={e => {
              if (e.key === "Enter") handleDeleteSubmit();
              if (e.key === "Escape") setShowDeletePrompt({ visible: false, path: "", name: "", isDir: false });
            }}
          >
            <div className="dialog-header">
              <span className="dialog-title">Delete {showDeletePrompt.isDir ? "Folder" : "File"}</span>
              <button
                className="dialog-close"
                onClick={() => setShowDeletePrompt({ visible: false, path: "", name: "", isDir: false })}
              >
                <i className="bx bx-x" />
              </button>
            </div>
            <div className="dialog-body" style={{ padding: "16px", fontSize: "12px", color: "var(--text-2)" }}>
              Are you sure you want to permanently delete <strong>{showDeletePrompt.name}</strong>?
              {showDeletePrompt.isDir && <div style={{ color: "#f87171", marginTop: "8px" }}><i className="bx bx-error-circle" style={{ marginRight: "4px" }} />This will delete all files inside the folder and cannot be undone!</div>}
            </div>
            <div className="dialog-footer" style={{ padding: "12px 16px" }}>
              <button
                className="stng-btn stng-btn-ghost"
                onClick={() => setShowDeletePrompt({ visible: false, path: "", name: "", isDir: false })}
                style={{ fontSize: "12px" }}
              >
                Cancel
              </button>
              <button
                className="stng-btn stng-btn-primary"
                onClick={handleDeleteSubmit}
                style={{ background: "#f87171", color: "#fff", border: "1px solid rgba(248,113,113,0.3)", fontSize: "12px" }}
              >
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface NodeProps {
  node: FileEntry;
  depth: number;
  activeFilePath: string | null;
  onFileSelect: (path: string, name: string) => void;
  onNodeContextMenu: (e: React.MouseEvent, path: string, name: string, isDir: boolean) => void;
  onRefresh: () => void;
}

let draggedNodePath: string | null = null;

const TreeNode: React.FC<NodeProps> = ({ node, depth, activeFilePath, onFileSelect, onNodeContextMenu, onRefresh }) => {
  const [open, setOpen] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const dragCounter = useRef(0);
  const { notifyError } = useNotify();

  const click = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.is_dir) {
      setOpen(o => !o);
    } else {
      onFileSelect(node.path, node.name);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    onNodeContextMenu(e, node.path, node.name, node.is_dir);
  };

  // ── Native DOM drag & drop — more reliable in Tauri/WebView2 ──
  useEffect(() => {
    const el = itemRef.current;
    if (!el) return;

    const onDragStart = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", node.path);
      draggedNodePath = node.path;
      el.classList.add("dragging-source");
    };

    const onDragEnd = () => {
      draggedNodePath = null;
      dragCounter.current = 0;
      el.classList.remove("dragging-source");
      // Clean up any orphaned drag-over-folder classes on all elements
      document.querySelectorAll(".drag-over-folder").forEach(elem =>
        elem.classList.remove("drag-over-folder")
      );
    };

    const onDragOver = (e: DragEvent) => {
      if (node.is_dir) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      }
    };

    const onDragEnter = () => {
      if (node.is_dir && draggedNodePath && draggedNodePath !== node.path) {
        dragCounter.current++;
        if (dragCounter.current === 1) {
          el.classList.add("drag-over-folder");
        }
      }
    };

    const onDragLeave = () => {
      if (node.is_dir) {
        dragCounter.current--;
        if (dragCounter.current <= 0) {
          dragCounter.current = 0;
          el.classList.remove("drag-over-folder");
        }
      }
    };

    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      el.classList.remove("drag-over-folder");

      const srcPath = e.dataTransfer?.getData("text/plain") || draggedNodePath;
      if (!srcPath || srcPath === node.path || !node.is_dir) return;

      const name = srcPath.split(/[\\/]/).pop();
      if (!name) return;

      const normSrc = srcPath.replace(/\\/g, "/");
      const destPath = node.path.replace(/\\/g, "/") + "/" + name;

      if (destPath.startsWith(normSrc)) {
        notifyError("Cannot move a folder into itself or its own subfolder!");
        return;
      }

      try {
        await invoke("rename_item", { oldPath: srcPath, newPath: destPath });
        onRefresh();
      } catch (err) {
        notifyError(`Failed to move: ${err}`);
      }
    };

    el.addEventListener("dragstart", onDragStart);
    el.addEventListener("dragend", onDragEnd);
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragenter", onDragEnter);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);

    return () => {
      el.removeEventListener("dragstart", onDragStart);
      el.removeEventListener("dragend", onDragEnd);
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragenter", onDragEnter);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, [node.path, node.is_dir]);

  const indent = 8 + depth * 14;
  const active = activeFilePath === node.path;

  return (
    <div className="tree-children">
      <div
        ref={itemRef}
        className={`tree-item ${active ? "selected" : ""}`}
        style={{ paddingLeft: indent }}
        onClick={click}
        onContextMenu={handleContextMenu}
        draggable={true}
      >
        {node.is_dir ? (
          <span className="tree-caret">
            <i className={`bx bx-chevron-${open ? "down" : "right"}`} />
          </span>
        ) : (
          <span className="tree-caret" />
        )}
        <span className={`tree-item-icon ${node.is_dir ? "dir" : "file"}`}>
          <i className={`bx bx${node.is_dir ? `s-folder${open ? "-open" : ""}` : "-file-blank"}`} />
        </span>
        <span className="tree-item-name">{node.name}</span>
      </div>
      {node.is_dir && open && node.children?.map(c => (
        <TreeNode
          key={c.path}
          node={c}
          depth={depth + 1}
          activeFilePath={activeFilePath}
          onFileSelect={onFileSelect}
          onNodeContextMenu={onNodeContextMenu}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  );
};
