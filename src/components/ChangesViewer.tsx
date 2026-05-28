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
  oldLine?: number;
  newLine?: number;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function computeFallbackDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const diffs: DiffLine[] = [];
  let o = 0;
  let n = 0;

  while (o < oldLines.length || n < newLines.length) {
    if (o >= oldLines.length) {
      diffs.push({ type: "added", text: newLines[n], newLine: n + 1 });
      n++;
    } else if (n >= newLines.length) {
      diffs.push({ type: "removed", text: oldLines[o], oldLine: o + 1 });
      o++;
    } else if (oldLines[o] === newLines[n]) {
      diffs.push({ type: "unchanged", text: oldLines[o], oldLine: o + 1, newLine: n + 1 });
      o++;
      n++;
    } else {
      const nextNew = newLines.indexOf(oldLines[o], n + 1);
      const nextOld = oldLines.indexOf(newLines[n], o + 1);
      if (nextNew !== -1 && (nextOld === -1 || nextNew - n < nextOld - o)) {
        diffs.push({ type: "added", text: newLines[n], newLine: n + 1 });
        n++;
      } else if (nextOld !== -1) {
        diffs.push({ type: "removed", text: oldLines[o], oldLine: o + 1 });
        o++;
      } else {
        diffs.push({ type: "removed", text: oldLines[o], oldLine: o + 1 });
        diffs.push({ type: "added", text: newLines[n], newLine: n + 1 });
        o++;
        n++;
      }
    }
  }

  return diffs;
}

// Stable line-by-line LCS diff. The previous lookahead diff drifted on nearby
// repeated lines, which made old/new hunks look unrelated.
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length === 0) return newLines.map((line, i) => ({ type: "added", text: line, newLine: i + 1 }));
  if (newLines.length === 0) return oldLines.map((line, i) => ({ type: "removed", text: line, oldLine: i + 1 }));

  const work = oldLines.length * newLines.length;
  if (work > 1_800_000) return computeFallbackDiff(oldLines, newLines);

  const table = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let o = oldLines.length - 1; o >= 0; o--) {
    for (let n = newLines.length - 1; n >= 0; n--) {
      table[o][n] = oldLines[o] === newLines[n]
        ? table[o + 1][n + 1] + 1
        : Math.max(table[o + 1][n], table[o][n + 1]);
    }
  }

  const diffs: DiffLine[] = [];
  let o = 0;
  let n = 0;
  while (o < oldLines.length && n < newLines.length) {
    if (oldLines[o] === newLines[n]) {
      diffs.push({ type: "unchanged", text: oldLines[o], oldLine: o + 1, newLine: n + 1 });
      o++;
      n++;
    } else if (table[o + 1][n] >= table[o][n + 1]) {
      diffs.push({ type: "removed", text: oldLines[o], oldLine: o + 1 });
      o++;
    } else {
      diffs.push({ type: "added", text: newLines[n], newLine: n + 1 });
      n++;
    }
  }
  while (o < oldLines.length) {
    diffs.push({ type: "removed", text: oldLines[o], oldLine: o + 1 });
    o++;
  }
  while (n < newLines.length) {
    diffs.push({ type: "added", text: newLines[n], newLine: n + 1 });
    n++;
  }

  return diffs;
}

interface ChangesViewerProps {
  changedFiles: ChangedFile[];
  baselineSnapshot: Record<string, string>;
  onFileSelect: (path: string, name: string, baselineContent?: string) => void;
}

export const ChangesViewer: React.FC<ChangesViewerProps> = ({
  changedFiles,
  baselineSnapshot,
  onFileSelect,
}) => {
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<DiffLine[] | null>(null);
  const [loading, setLoading] = useState(false);

  const baselineFor = (file: ChangedFile) => file.status === "new" ? "" : baselineSnapshot[file.path] ?? "";

  const toggleExpand = async (file: ChangedFile) => {
    if (expandedFile === file.path) {
      setExpandedFile(null);
      setDiffData(null);
      return;
    }

    setLoading(true);
    setExpandedFile(file.path);
    try {
      const content = await invoke<string>("read_file_content", { filePath: file.path });
      setDiffData(computeLineDiff(baselineFor(file), content));
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
                <div className="change-card-header" onClick={() => toggleExpand(file)}>
                  <i className={`bx ${file.status === "new" ? "bx-file-blank text-ok" : "bx-edit-alt text-warn"} change-status-icon`} />
                  <div className="change-file-details">
                    <span className="change-file-name">{file.name}</span>
                    <span className="change-file-path">{file.path}</span>
                  </div>
                  <span className={`change-badge ${file.status}`}>
                    {file.status === "new" ? "NEW" : "MODIFIED"}
                  </span>
                  <i className={`bx bx-chevron-${isExpanded ? "down" : "right"} change-chevron`} />
                </div>

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
                              onFileSelect(file.path, file.name, baselineFor(file));
                            }}
                          >
                            <i className="bx bx-expand-alt" /> Open Full Diff
                          </button>
                        </div>
                        <div className="diff-scroll">
                          {diffData?.map((line, index) => {
                            const lineClass = line.type === "added" ? "added" : line.type === "removed" ? "removed" : "unchanged";
                            const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
                            return (
                              <div key={index} className={`diff-line ${lineClass}`}>
                                <span className="diff-ln diff-ln-old">{line.oldLine ?? ""}</span>
                                <span className="diff-ln diff-ln-new">{line.newLine ?? ""}</span>
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
