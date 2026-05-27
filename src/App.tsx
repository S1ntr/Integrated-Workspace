import { useState } from "react";
import { Onboarding, OnboardingConfig } from "./components/Onboarding";
import { WorkspaceLayout } from "./components/WorkspaceLayout";
import { NotifyProvider } from "./components/Notification";

function App() {
  const [config, setConfig] = useState<OnboardingConfig | null>(null);

  return (
    <NotifyProvider>
      {config === null ? (
        <Onboarding onComplete={(cfg) => setConfig(cfg)} />
      ) : (
        <WorkspaceLayout
          directory={config.directory}
          initialSessions={config.sessions}
        />
      )}
    </NotifyProvider>
  );
}

export default App;
