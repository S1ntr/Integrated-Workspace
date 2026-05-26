import { useState } from "react";
import { Onboarding, OnboardingConfig } from "./components/Onboarding";
import { WorkspaceLayout } from "./components/WorkspaceLayout";

function App() {
  const [config, setConfig] = useState<OnboardingConfig | null>(null);

  return (
    <>
      {config === null ? (
        <Onboarding onComplete={(cfg) => setConfig(cfg)} />
      ) : (
        <WorkspaceLayout
          directory={config.directory}
          initialSessions={config.sessions}
        />
      )}
    </>
  );
}

export default App;
