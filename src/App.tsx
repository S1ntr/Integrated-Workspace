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
      </div>
    </NotifyProvider>
  );
}

export default App;
