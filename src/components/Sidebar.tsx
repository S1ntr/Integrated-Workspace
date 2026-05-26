import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

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
  const prevJson = React.useRef("");

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

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!directory) return;
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [refresh, directory]);


  return (
    <div className="file-sidebar" style={{ width }}>
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
          />
        ))}
      </div>
    </div>
  );
};

interface NodeProps {
  node: FileEntry;
  depth: number;
  activeFilePath: string | null;
  onFileSelect: (path: string, name: string) => void;
}

const TreeNode: React.FC<NodeProps> = ({ node, depth, activeFilePath, onFileSelect }) => {
  const [open, setOpen] = useState(false);

  const click = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.is_dir) {
      setOpen(o => !o);
    } else {
      onFileSelect(node.path, node.name);
    }
  };

  const indent = 8 + depth * 14;
  const active = activeFilePath === node.path;

  return (
    <div className="tree-children">
      <div
        className={`tree-item ${active ? "selected" : ""}`}
        style={{ paddingLeft: indent }}
        onClick={click}
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
        />
      ))}
    </div>
  );
};
