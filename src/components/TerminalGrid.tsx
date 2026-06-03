import React, { useRef, useState, useCallback, useEffect } from "react";
import { TerminalPanel } from "./TerminalPanel";

export interface Session {
  id: number;
  sessionId: string;
  label: string;
  command: string;
  status?: "booting" | "running" | "exited";
}

interface TerminalGridProps {
  sessions: Session[];
  workspaceDir: string;
  onClose: (id: number) => void;
  onChangeAgent: (id: number, label: string, command: string) => void;
  onAddSessionClick?: () => void;
  onSwapSessions?: (idA: number, idB: number) => void;
  onStatusChange?: (id: number, status: "booting" | "running" | "exited") => void;
}

// Notify all TerminalPanels that a drag-resize just ended so they can
// do a full fit+refresh pass and clear any stale canvas pixels.
function dispatchResizeEnd() {
  window.dispatchEvent(new Event("termgrid-resize-end"));
}

// ── Snap helper ────────────────────────────────────────────────────────────────
const SNAP_POINTS = [25, 33, 50, 67, 75];
const SNAP_THRESHOLD = 3.5; // % — snap zone radius

function snap(pct: number): number {
  for (const s of SNAP_POINTS) {
    if (Math.abs(pct - s) < SNAP_THRESHOLD) return s;
  }
  return pct;
}

// ── Row assignment ───────────────────────────────────────────────────────────
// Distributes sessions dynamically into a balanced grid of rows and columns.
function partitionSessions(sessions: Session[], rowCount: number): Session[][] {
  const rows: Session[][] = Array.from({ length: rowCount }, () => []);
  const baseCount = Math.floor(sessions.length / rowCount);
  const extra = sessions.length % rowCount;

  let sIdx = 0;
  for (let r = 0; r < rowCount; r++) {
    const count = baseCount + (r < extra ? 1 : 0);
    for (let c = 0; c < count; c++) {
      if (sIdx < sessions.length) {
        rows[r].push(sessions[sIdx++]);
      }
    }
  }
  return rows;
}

// ── Main TerminalGrid ──────────────────────────────────────────────────────────
export const TerminalGrid: React.FC<TerminalGridProps> = ({
  sessions,
  workspaceDir,
  onClose,
  onChangeAgent,
  onAddSessionClick,
  onSwapSessions,
  onStatusChange,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [fullscreenId, setFullscreenId] = useState<number | null>(null);
  const [draggingSessionId, setDraggingSessionId] = useState<number | null>(null);
  const [dragOverSessionId, setDragOverSessionId] = useState<number | null>(null);
  const dragOverSessionIdRef = useRef<number | null>(null);

  const N = sessions.length;

  // ── States for independent 4-quadrant layout (N === 4) ───────────────────────
  const [colPctTop, setColPctTop] = useState(50);
  const [colPctBottom, setColPctBottom] = useState(50);
  const [rowPctLeft, setRowPctLeft] = useState(50);
  const [rowPctRight, setRowPctRight] = useState(50);

  // ── States for generic grid layout (N !== 4) ─────────────────────────────────
  const rowCount = N <= 2 ? 1 : N <= 4 ? 2 : N <= 9 ? 3 : 4;
  const [rowPcts, setRowPcts] = useState<number[]>([]);
  const [colPcts, setColPcts] = useState<number[][]>([]);

  const rows = partitionSessions(sessions, rowCount);

  const startSessionReorder = useCallback((session: Session, e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || isResizing) return;
    const target = e.target as HTMLElement;
    if (
      !target.closest(".term-bar") ||
      target.closest("button") ||
      target.closest(".term-agent-dropdown-menu")
    ) {
      return;
    }

    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;

    const cleanup = () => {
      document.body.classList.remove("terminal-reorder-active");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragOverSessionIdRef.current = null;
      setDraggingSessionId(null);
      setDragOverSessionId(null);
    };

    const onMove = (me: MouseEvent) => {
      const moved = Math.hypot(me.clientX - startX, me.clientY - startY);
      if (!active && moved < 5) return;
      if (!active) {
        active = true;
        document.body.classList.add("terminal-reorder-active");
        setDraggingSessionId(session.id);
      }
      me.preventDefault();
      const underPointer = document.elementFromPoint(me.clientX, me.clientY) as HTMLElement | null;
      const panel = underPointer?.closest("[data-terminal-panel-id]") as HTMLElement | null;
      const targetId = panel ? Number(panel.dataset.terminalPanelId) : null;
      const nextTarget = Number.isFinite(targetId) ? targetId : null;
      dragOverSessionIdRef.current = nextTarget;
      setDragOverSessionId(nextTarget);
    };

    const onUp = () => {
      const targetId = dragOverSessionIdRef.current;
      if (active && targetId !== null && targetId !== session.id) {
        onSwapSessions?.(session.id, targetId);
      }
      cleanup();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isResizing, onSwapSessions]);

  // Synchronize generic grid percentages
  useEffect(() => {
    setRowPcts(prev => {
      if (prev.length === rowCount) return prev;
      return Array(rowCount).fill(100 / rowCount);
    });

    setColPcts(prev => {
      const next = prev.map(row => [...row]);
      let changed = false;

      if (next.length !== rowCount) {
        next.length = rowCount;
        changed = true;
      }

      for (let r = 0; r < rowCount; r++) {
        const C = rows[r]?.length || 0;
        if (!next[r] || next[r].length !== C) {
          next[r] = Array(C).fill(100 / C);
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [N, rowCount]);

  // ── Drag Handlers for independent 4-quadrant layout (N === 4) ─────────────────
  const startColTopDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    setIsResizing(true);
    const onMove = (me: MouseEvent) => {
      const raw = ((me.clientX - rect.left) / rect.width) * 100;
      setColPctTop(snap(Math.max(15, Math.min(85, raw))));
    };
    const onUp = () => {
      setIsResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dispatchResizeEnd();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const startColBottomDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    setIsResizing(true);
    const onMove = (me: MouseEvent) => {
      const raw = ((me.clientX - rect.left) / rect.width) * 100;
      setColPctBottom(snap(Math.max(15, Math.min(85, raw))));
    };
    const onUp = () => {
      setIsResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dispatchResizeEnd();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const startRowLeftDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    setIsResizing(true);
    const onMove = (me: MouseEvent) => {
      const raw = ((me.clientY - rect.top) / rect.height) * 100;
      setRowPctLeft(snap(Math.max(15, Math.min(85, raw))));
    };
    const onUp = () => {
      setIsResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dispatchResizeEnd();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const startRowRightDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    setIsResizing(true);
    const onMove = (me: MouseEvent) => {
      const raw = ((me.clientY - rect.top) / rect.height) * 100;
      setRowPctRight(snap(Math.max(15, Math.min(85, raw))));
    };
    const onUp = () => {
      setIsResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dispatchResizeEnd();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // ── Drag Handlers for generic grid layout ────────────────────────────────────
  const startColDrag = useCallback((r: number, c: number, e: React.MouseEvent) => {
    e.preventDefault();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    setIsResizing(true);

    const currentPcts = colPcts[r] || [];
    const C = currentPcts.length;
    if (C === 0) return;

    let leftPct = 0;
    for (let j = 0; j < c; j++) {
      leftPct += currentPcts[j] || (100 / C);
    }

    const combinedPct = (currentPcts[c] || (100 / C)) + (currentPcts[c + 1] || (100 / C));

    const onMove = (me: MouseEvent) => {
      const currentPct = ((me.clientX - rect.left) / rect.width) * 100;
      const relativePct = currentPct - leftPct;

      const minPct = 12;
      const maxPct = combinedPct - minPct;
      const clamped = Math.max(minPct, Math.min(maxPct, relativePct));

      setColPcts(prev => {
        const next = prev.map((row, i) => i === r ? [...row] : row);
        next[r][c] = snap(clamped);
        next[r][c + 1] = snap(combinedPct - clamped);
        return next;
      });
    };

    const onUp = () => {
      setIsResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dispatchResizeEnd();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [colPcts]);

  const startRowDrag = useCallback((idx: number, e: React.MouseEvent) => {
    e.preventDefault();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    setIsResizing(true);

    let topPct = 0;
    for (let j = 0; j < idx; j++) {
      topPct += rowPcts[j] || (100 / rowCount);
    }

    const combinedPct = (rowPcts[idx] || (100 / rowCount)) + (rowPcts[idx + 1] || (100 / rowCount));

    const onMove = (me: MouseEvent) => {
      const currentPct = ((me.clientY - rect.top) / rect.height) * 100;
      const relativePct = currentPct - topPct;

      const minPct = 12;
      const maxPct = combinedPct - minPct;
      const clamped = Math.max(minPct, Math.min(maxPct, relativePct));

      setRowPcts(prev => {
        const next = [...prev];
        next[idx] = snap(clamped);
        next[idx + 1] = snap(combinedPct - clamped);
        return next;
      });
    };

    const onUp = () => {
      setIsResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dispatchResizeEnd();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [rowPcts, rowCount]);

  if (N === 0) {
    return (
      <div className="tgrid-placeholder-container">
        <div className="tgrid-placeholder-card">
          <div className="tgrid-placeholder-icon">
            <i className="bx bx-terminal" />
          </div>
          <h2 className="tgrid-placeholder-title">No Active Terminals</h2>
          <p className="tgrid-placeholder-text">
            Launch a new shell or AI agent terminal to start developing in this workspace.
          </p>
          <button className="tgrid-placeholder-btn" onClick={onAddSessionClick}>
            <i className="bx bx-plus" />
            Launch Terminal
          </button>
        </div>
      </div>
    );
  }

  // ── Pre-calculate panel coordinates for all layouts ──────────────────────────
  const panels: { s: Session; left: number; top: number; width: number; height: number; pct: number }[] = [];

  if (N === 4) {
    panels.push(
      { s: sessions[0], left: 0, top: 0, width: colPctTop, height: rowPctLeft, pct: colPctTop },
      { s: sessions[1], left: colPctTop, top: 0, width: 100 - colPctTop, height: rowPctRight, pct: 100 - colPctTop },
      { s: sessions[2], left: 0, top: rowPctLeft, width: colPctBottom, height: 100 - rowPctLeft, pct: colPctBottom },
      { s: sessions[3], left: colPctBottom, top: rowPctRight, width: 100 - colPctBottom, height: 100 - rowPctRight, pct: 100 - colPctBottom }
    );
  } else {
    let currentTop = 0;
    for (let r = 0; r < rowCount; r++) {
      const rowHeight = rowPcts[r] || (100 / rowCount);
      const rowSessions = rows[r] || [];
      const C = rowSessions.length;

      let currentLeft = 0;
      for (let c = 0; c < C; c++) {
        const colWidth = colPcts[r]?.[c] || (100 / C);
        panels.push({
          s: rowSessions[c],
          left: currentLeft,
          top: currentTop,
          width: colWidth,
          height: rowHeight,
          pct: colWidth,
        });
        currentLeft += colWidth;
      }
      currentTop += rowHeight;
    }
  }

  return (
    <div className={`tgrid-wrapper ${isResizing ? "resizing" : ""} ${draggingSessionId !== null ? "reordering" : ""}${fullscreenId !== null ? " has-fullscreen" : ""}`} ref={wrapperRef} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", isolation: "isolate" }}>
      {/* ── Render absolutely positioned panels ── */}
      {panels.map(({ s, left, top, width, height, pct }) => (
        <div
          key={s.id}
          className={`tgrid-absolute-panel ${draggingSessionId === s.id ? "dragging" : ""} ${dragOverSessionId === s.id && draggingSessionId !== s.id ? "drag-over" : ""}`}
          data-terminal-panel-id={s.id}
          onMouseDown={(e) => fullscreenId !== s.id && startSessionReorder(s, e)}
          style={fullscreenId === s.id ? {
            position: "absolute",
            left: 0, top: 0, width: "100%", height: "100%",
            zIndex: 500,
          } : fullscreenId !== null ? {
            position: "absolute",
            left: `${left}%`,
            top: `${top}%`,
            width: `${width}%`,
            height: `${height}%`,
            zIndex: 1,
            isolation: "isolate" as const,
          } : {
            position: "absolute",
            left: `${left}%`,
            top: `${top}%`,
            width: `${width}%`,
            height: `${height}%`,
          }}
        >
          <TerminalPanel
            key={s.id}
            {...s}
            workspaceDir={workspaceDir}
            widthPercent={pct}
            fullscreened={fullscreenId === s.id}
            onClose={onClose}
            onChangeAgent={onChangeAgent}
            onToggleFullscreen={(id) => setFullscreenId(prev => prev === id ? null : id)}
            onSwapSessions={onSwapSessions}
            onStatusChange={onStatusChange}
          />
        </div>
      ))}

      {/* ── Render resize handles for N === 4 layout ── */}
      {N === 4 && (
        <>
          <div
            className="tgrid-handle tgrid-handle-v"
            style={{
              position: "absolute",
              left: `calc(${colPctTop}% - 4px)`,
              top: 0,
              height: `${Math.min(rowPctLeft, rowPctRight)}%`,
              zIndex: 30,
            }}
            onMouseDown={startColTopDrag}
          >
            <div className="tgrid-handle-bar" />
          </div>

          <div
            className="tgrid-handle tgrid-handle-v"
            style={{
              position: "absolute",
              left: `calc(${colPctBottom}% - 4px)`,
              top: `${Math.max(rowPctLeft, rowPctRight)}%`,
              height: `${100 - Math.max(rowPctLeft, rowPctRight)}%`,
              zIndex: 30,
            }}
            onMouseDown={startColBottomDrag}
          >
            <div className="tgrid-handle-bar" />
          </div>

          <div
            className="tgrid-handle tgrid-handle-h"
            style={{
              position: "absolute",
              left: 0,
              top: `calc(${rowPctLeft}% - 4px)`,
              width: `${Math.min(colPctTop, colPctBottom)}%`,
              zIndex: 30,
            }}
            onMouseDown={startRowLeftDrag}
          >
            <div className="tgrid-handle-bar" />
          </div>

          <div
            className="tgrid-handle tgrid-handle-h"
            style={{
              position: "absolute",
              left: `${Math.max(colPctTop, colPctBottom)}%`,
              top: `calc(${rowPctRight}% - 4px)`,
              width: `${100 - Math.max(colPctTop, colPctBottom)}%`,
              zIndex: 30,
            }}
            onMouseDown={startRowRightDrag}
          >
            <div className="tgrid-handle-bar" />
          </div>
        </>
      )}

      {/* ── Render resize handles for other configurations ── */}
      {N !== 4 && (
        <>
          {rows.map((rowSessions, r) => {
            const C = rowSessions.length;
            if (C <= 1) return null;

            let leftAccum = 0;
            let topPct = 0;
            for (let j = 0; j < r; j++) {
              topPct += rowPcts[j] || (100 / rowCount);
            }
            const rowHeight = rowPcts[r] || (100 / rowCount);

            return (
              <React.Fragment key={`v-handles-${r}`}>
                {Array.from({ length: C - 1 }).map((_, c) => {
                  leftAccum += colPcts[r]?.[c] || (100 / C);
                  return (
                    <div
                      key={`v-handle-${r}-${c}`}
                      className="tgrid-handle tgrid-handle-v"
                      style={{
                        position: "absolute",
                        left: `calc(${leftAccum}% - 4px)`,
                        top: `${topPct}%`,
                        height: `${rowHeight}%`,
                        zIndex: 30,
                      }}
                      onMouseDown={(e) => startColDrag(r, c, e)}
                    >
                      <div className="tgrid-handle-bar" />
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}

          {rowCount > 1 &&
            Array.from({ length: rowCount - 1 }).map((_, r) => {
              let topPct = 0;
              for (let j = 0; j <= r; j++) {
                topPct += rowPcts[j] || (100 / rowCount);
              }

              return (
                <div
                  key={`h-handle-${r}`}
                  className="tgrid-handle tgrid-handle-h"
                  style={{
                    position: "absolute",
                    left: 0,
                    top: `calc(${topPct}% - 4px)`,
                    width: "100%",
                    zIndex: 30,
                  }}
                  onMouseDown={(e) => startRowDrag(r, e)}
                >
                  <div className="tgrid-handle-bar" />
                </div>
              );
            })}
        </>
      )}
    </div>
  );
};
