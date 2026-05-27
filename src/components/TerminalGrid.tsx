import React, { useRef, useState, useCallback } from "react";
import { TerminalPanel } from "./TerminalPanel";

export interface Session {
  id: number;
  sessionId: string;
  label: string;
  command: string;
}

interface TerminalGridProps {
  sessions: Session[];
  workspaceDir: string;
  onClose: (id: number) => void;
  onChangeAgent: (id: number, label: string, command: string) => void;
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

// ── Column assignment ──────────────────────────────────────────────────────────
// Distributes sessions into left and right columns
// [0,2,4] → left   [1,3,5] → right
function assignColumns(sessions: Session[]): { left: Session[]; right: Session[] } {
  const left:  Session[] = [];
  const right: Session[] = [];
  const colCount = sessions.length <= 1 ? 1 : 2;
  sessions.forEach((s, i) => {
    if (colCount === 1 || i % 2 === 0) left.push(s);
    else right.push(s);
  });
  return { left, right };
}

// ── Vertical split pane within one column ──────────────────────────────────────
interface ColProps {
  sessions: Session[];
  workspaceDir: string;
  onClose: (id: number) => void;
  onChangeAgent: (id: number, label: string, command: string) => void;
  colRef: React.RefObject<HTMLDivElement | null>;
}

const SplitColumn: React.FC<ColProps> = ({ sessions, workspaceDir, onClose, onChangeAgent, colRef }) => {
  const [rowPct, setRowPct] = useState(50);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const col = colRef.current;
    if (!col) return;
    const rect = col.getBoundingClientRect();

    const onMove = (me: MouseEvent) => {
      const raw = ((me.clientY - rect.top) / rect.height) * 100;
      setRowPct(snap(Math.max(15, Math.min(85, raw))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [colRef]);

  if (sessions.length === 0) return null;

  if (sessions.length === 1) {
    return (
      <div className="tgrid-col-panel">
        <TerminalPanel key={sessions[0].id} {...sessions[0]} workspaceDir={workspaceDir} widthPercent={100} onClose={onClose} onChangeAgent={onChangeAgent} />
      </div>
    );
  }

  // Two panels split vertically with independent handle
  return (
    <>
      <div className="tgrid-col-panel" style={{ flex: `${rowPct} 1 0%` }}>
        <TerminalPanel key={sessions[0].id} {...sessions[0]} workspaceDir={workspaceDir} widthPercent={100} onClose={onClose} onChangeAgent={onChangeAgent} />
      </div>

      {/* Horizontal resize handle for THIS column only */}
      <div className="tgrid-handle tgrid-handle-h" onMouseDown={startDrag}>
        <div className="tgrid-handle-bar" />
      </div>

      <div className="tgrid-col-panel" style={{ flex: `${100 - rowPct} 1 0%` }}>
        {sessions[1] && (
          <TerminalPanel key={sessions[1].id} {...sessions[1]} workspaceDir={workspaceDir} widthPercent={100} onClose={onClose} onChangeAgent={onChangeAgent} />
        )}
      </div>

      {/* Extra panels beyond 2 stacked at bottom */}
      {sessions.slice(2).map(s => (
        <div key={s.id} className="tgrid-col-panel" style={{ flex: "1 1 0%" }}>
          <TerminalPanel key={s.id} {...s} workspaceDir={workspaceDir} widthPercent={100} onClose={onClose} onChangeAgent={onChangeAgent} />
        </div>
      ))}
    </>
  );
};

// ── Main TerminalGrid ──────────────────────────────────────────────────────────
export const TerminalGrid: React.FC<TerminalGridProps> = ({ sessions, workspaceDir, onClose, onChangeAgent }) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const leftColRef  = useRef<HTMLDivElement>(null);
  const rightColRef = useRef<HTMLDivElement>(null);

  const [colPct, setColPct] = useState(50); // left column width %

  const { left, right } = assignColumns(sessions);
  const hasTwoCols = right.length > 0;

  // ── Vertical column-resize drag ────────────────────────────────────────────
  const startColDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();

    const onMove = (me: MouseEvent) => {
      const raw = ((me.clientX - rect.left) / rect.width) * 100;
      setColPct(snap(Math.max(15, Math.min(85, raw))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return (
    <div className="tgrid-wrapper" ref={wrapperRef}>
      {/* Left column */}
      <div
        ref={leftColRef}
        className="tgrid-col"
        style={{ flex: hasTwoCols ? `${colPct} 1 0%` : "1 1 0%" }}
      >
        <SplitColumn
          sessions={left}
          workspaceDir={workspaceDir}
          onClose={onClose}
          onChangeAgent={onChangeAgent}
          colRef={leftColRef}
        />
      </div>

      {/* Vertical column divider */}
      {hasTwoCols && (
        <div className="tgrid-handle tgrid-handle-v" onMouseDown={startColDrag}>
          <div className="tgrid-handle-bar" />
        </div>
      )}

      {/* Right column — its own independent row split */}
      {hasTwoCols && (
        <div
          ref={rightColRef}
          className="tgrid-col"
          style={{ flex: `${100 - colPct} 1 0%` }}
        >
          <SplitColumn
            sessions={right}
            workspaceDir={workspaceDir}
            onClose={onClose}
            onChangeAgent={onChangeAgent}
            colRef={rightColRef}
          />
        </div>
      )}
    </div>
  );
};
