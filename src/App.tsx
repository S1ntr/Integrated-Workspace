import { useEffect, useRef, useState } from "react";
import { Onboarding, OnboardingConfig } from "./components/Onboarding";
import { WorkspaceLayout } from "./components/WorkspaceLayout";
import { NotifyProvider } from "./components/Notification";

interface WorkspaceInstance extends OnboardingConfig {
  id: string;
  name: string;
  createdAt: number;
}

function workspaceNameFromPath(directory: string): string {
  return directory.split(/[\\/]/).filter(Boolean).pop() || "Workspace";
}

function App() {
  const [workspaces, setWorkspaces] = useState<WorkspaceInstance[]>([]);
  const [activeId, setActiveId] = useState("");
  const [addingWorkspace, setAddingWorkspace] = useState(true);
  const [busyWorkspaces, setBusyWorkspaces] = useState<Record<string, boolean>>({});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [closingWorkspace, setClosingWorkspace] = useState<WorkspaceInstance | null>(null);
  const busyTimersRef = useRef<Record<string, number>>({});

  useEffect(() => () => {
    Object.values(busyTimersRef.current).forEach(timer => window.clearTimeout(timer));
  }, []);

  const addWorkspace = (config: OnboardingConfig) => {
    const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const workspace: WorkspaceInstance = {
      ...config,
      id,
      name: workspaceNameFromPath(config.directory),
      createdAt: Date.now(),
    };
    setWorkspaces(prev => [...prev, workspace]);
    setActiveId(id);
    setAddingWorkspace(false);
  };

  const markWorkspaceActivity = (id: string) => {
    setBusyWorkspaces(prev => ({ ...prev, [id]: true }));
    window.clearTimeout(busyTimersRef.current[id]);
    busyTimersRef.current[id] = window.setTimeout(() => {
      setBusyWorkspaces(prev => ({ ...prev, [id]: false }));
    }, 4500);
  };

  const startRename = (workspace: WorkspaceInstance) => {
    setRenamingId(workspace.id);
    setRenameDraft(workspace.name);
  };

  const commitRename = (id: string) => {
    const nextName = renameDraft.trim();
    if (nextName) {
      setWorkspaces(prev => prev.map(workspace =>
        workspace.id === id ? { ...workspace, name: nextName } : workspace
      ));
    }
    setRenamingId(null);
    setRenameDraft("");
  };

  const closeWorkspace = (id: string) => {
    window.clearTimeout(busyTimersRef.current[id]);
    delete busyTimersRef.current[id];
    setBusyWorkspaces(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setWorkspaces(prev => {
      const next = prev.filter(workspace => workspace.id !== id);
      if (activeId === id) {
        const currentIndex = prev.findIndex(workspace => workspace.id === id);
        const fallback = next[Math.max(0, Math.min(currentIndex, next.length - 1))];
        setActiveId(fallback?.id || "");
        setAddingWorkspace(next.length === 0);
      }
      return next;
    });
    setClosingWorkspace(null);
  };

  const activeWorkspace = workspaces.find(workspace => workspace.id === activeId);

  return (
    <NotifyProvider>
      <div className="workspace-root">
        {workspaces.length > 0 && (
          <div className="workspace-switcher" role="tablist" aria-label="Workspaces">
            <div className="workspace-tabs">
              {workspaces.map(workspace => {
                const active = workspace.id === activeId;
                const busy = busyWorkspaces[workspace.id];
                return (
                  <button
                    key={workspace.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`workspace-tab ${active ? "active" : ""}`}
                    title={`${workspace.name}\n${workspace.directory}`}
                    onClick={() => setActiveId(workspace.id)}
                    onDoubleClick={() => startRename(workspace)}
                  >
                    {busy ? (
                      <i className="bx bx-loader-alt bx-spin workspace-tab-busy" />
                    ) : (
                      <i className="bx bx-folder" />
                    )}
                    {renamingId === workspace.id ? (
                      <input
                        value={renameDraft}
                        onChange={event => setRenameDraft(event.target.value)}
                        onClick={event => event.stopPropagation()}
                        onKeyDown={event => {
                          if (event.key === "Enter") commitRename(workspace.id);
                          if (event.key === "Escape") {
                            setRenamingId(null);
                            setRenameDraft("");
                          }
                        }}
                        onBlur={() => commitRename(workspace.id)}
                        autoFocus
                      />
                    ) : (
                      <span>{workspace.name}</span>
                    )}
                    {active && renamingId !== workspace.id && (
                      <span
                        className="workspace-tab-rename"
                        role="button"
                        tabIndex={0}
                        title="Rename workspace"
                        onClick={event => {
                          event.stopPropagation();
                          startRename(workspace);
                        }}
                        onKeyDown={event => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            startRename(workspace);
                          }
                        }}
                      >
                        <i className="bx bx-edit-alt" />
                      </span>
                    )}
                    {renamingId !== workspace.id && (
                      <span
                        className="workspace-tab-close"
                        role="button"
                        tabIndex={0}
                        title="Close workspace"
                        onClick={event => {
                          event.stopPropagation();
                          setClosingWorkspace(workspace);
                        }}
                        onKeyDown={event => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setClosingWorkspace(workspace);
                          }
                        }}
                      >
                        <i className="bx bx-x" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="workspace-add-btn"
              onClick={() => setAddingWorkspace(true)}
              title="Add workspace"
            >
              <i className="bx bx-plus" />
            </button>
          </div>
        )}

        <div className="workspace-layers">
          {workspaces.map(workspace => (
            <div
              key={workspace.id}
              className={`workspace-layer ${workspace.id === activeId ? "active" : "inactive"}`}
              aria-hidden={workspace.id !== activeId}
            >
              <WorkspaceLayout
                workspaceId={workspace.id}
                directory={workspace.directory}
                initialSessions={workspace.sessions}
                isActive={workspace.id === activeId}
                onWorkspaceActivity={() => markWorkspaceActivity(workspace.id)}
              />
            </div>
          ))}
        </div>

        {(!activeWorkspace || addingWorkspace) && (
          <Onboarding
            onComplete={addWorkspace}
            onCancel={workspaces.length ? () => setAddingWorkspace(false) : undefined}
          />
        )}

        {closingWorkspace && (
          <div className="workspace-close-overlay" role="dialog" aria-modal="true">
            <div className="workspace-close-dialog">
              <div className="workspace-close-icon">
                <i className="bx bx-window-close" />
              </div>
              <h2>Want to close this workspace?</h2>
              <p>
                Closing <strong>{closingWorkspace.name}</strong> will stop its terminals and remove it from this window.
              </p>
              <div className="workspace-close-actions">
                <button type="button" className="workspace-close-no" onClick={() => setClosingWorkspace(null)}>
                  No
                </button>
                <button type="button" className="workspace-close-yes" onClick={() => closeWorkspace(closingWorkspace.id)}>
                  Yes
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </NotifyProvider>
  );
}

export default App;
