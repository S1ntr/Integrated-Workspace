import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ChangedFile {
  name: string;
  path: string;
  status: "new" | "modified";
}

export interface DiffLine {
  type: "added" | "removed" | "unchanged";
  text: string;
}

// ── O(N) Lookahead Line-by-Line Diff Generator ───────────────────────────────
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);

  const diffs: DiffLine[] = [];
  let o = 0;
  let n = 0;

  // If old is entirely empty (new file), mark all as added
  if (oldText === "") {
    return newLines.map(line => ({ type: "added", text: line }));
  }

  while (o < oldLines.length || n < newLines.length) {
    if (o >= oldLines.length) {
      diffs.push({ type: "added", text: newLines[n] });
      n++;
    } else if (n >= newLines.length) {
      diffs.push({ type: "removed", text: oldLines[o] });
      o++;
    } else if (oldLines[o] === newLines[n]) {
      diffs.push({ type: "unchanged", text: oldLines[o] });
      o++;
      n++;
    } else {
      const nextMatchInNew = newLines.indexOf(oldLines[o], n);
      const nextMatchInOld = oldLines.indexOf(newLines[n], o);

      if (nextMatchInNew !== -1 && (nextMatchInOld === -1 || nextMatchInNew - n < nextMatchInOld - o)) {
        while (n < nextMatchInNew) {
          diffs.push({ type: "added", text: newLines[n] });
          n++;
        }
      } else if (nextMatchInOld !== -1 && (nextMatchInNew === -1 || nextMatchInOld - o <= nextMatchInNew - n)) {
        while (o < nextMatchInOld) {
          diffs.push({ type: "removed", text: oldLines[o] });
          o++;
        }
      } else {
        diffs.push({ type: "removed", text: oldLines[o] });
        diffs.push({ type: "added", text: newLines[n] });
        o++;
        n++;
      }
    }
  }

  return diffs;
}

interface ChangesViewerProps {
  changedFiles: ChangedFile[];
  baselineSnapshot: Record<string, string>; // path -> content snapshot
  onFileSelect: (path: string, name: string) => void;
}

export const ChangesViewer: React.FC<ChangesViewerProps> = ({
  changedFiles,
  baselineSnapshot,
  onFileSelect,
}) => {
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<DiffLine[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggleExpand = async (file: ChangedFile) => {
    if (expandedFile === file.path) {
      setExpandedFile(null);
      setDiffData(null);
      return;
    }

    setLoading(true);
    setExpandedFile(file.path);
    try {
      // Read current file content
      const content = await invoke<string>("read_file_content", { filePath: file.path });

      // Compute diff against baseline
      const oldContent = baselineSnapshot[file.path] || "";
      const diffResult = computeLineDiff(oldContent, content);
      setDiffData(diffResult);
    } catch (err) {
      setDiffData([{ type: "unchanged", text: `Error generating diff: ${err}` }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="changes-viewer">
      <div className="changes-header">
        <span className="changes-title">Pending Changes</span>
        <span className="changes-count-badge">
          {changedFiles.length} file{changedFiles.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="changes-list">
        {changedFiles.length === 0 ? (
          <div className="changes-empty">
            <i className="bx bx-check-shield" />
            <span className="changes-empty-label">No local changes</span>
            <span className="changes-empty-sub">
              Modified or created files will appear here with instant inline diffs.
            </span>
          </div>
        ) : (
          changedFiles.map((file) => {
            const isExpanded = expandedFile === file.path;
            return (
              <div key={file.path} className={`change-card ${isExpanded ? "expanded" : ""}`}>
                {/* Header / Accordion Trigger */}
                <div className="change-card-header" onClick={() => toggleExpand(file)}>
                  <i className={`bx ${file.status === "new" ? "bx-file-blank text-ok" : "bx-edit-alt text-warn"} change-status-icon`} />
                  <div className="change-file-details">
                    <span className="change-file-name">{file.name}</span>
                    <span className="change-file-path">{file.path.split(/[\\/]/).pop()}</span>
                  </div>
                  <span className={`change-badge ${file.status}`}>
                    {file.status === "new" ? "NEW" : "MODIFIED"}
                  </span>
                  <i className={`bx bx-chevron-${isExpanded ? "down" : "right"} change-chevron`} />
                </div>

                {/* Expanded Accordion Body — Diff Area */}
                {isExpanded && (
                  <div className="change-card-body">
                    {loading ? (
                      <div className="change-loading">
                        <i className="bx bx-loader-alt bx-spin" /> Loading diff...
                      </div>
                    ) : (
                      <div className="diff-viewer">
                        <div className="diff-actions">
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              onFileSelect(file.path, file.name);
                            }}
                          >
                            <i className="bx bx-expand-alt" /> Open Full File
                          </button>
                        </div>
                        <div className="diff-scroll">
                          {diffData?.map((line, index) => {
                            const lineClass = line.type === "added" ? "added" : line.type === "removed" ? "removed" : "unchanged";
                            const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
                            return (
                              <div key={index} className={`diff-line ${lineClass}`}>
                                <span className="diff-ln">{index + 1}</span>
                                <span className="diff-marker">{prefix}</span>
                                <span className="diff-code">{line.text || " "}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
