import React, { createContext, useContext, useState, useCallback, useRef } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────────

type NotifyType = "info" | "success" | "warning" | "error";

interface Notification {
  id: number;
  type: NotifyType;
  message: string;
}

interface NotifyContextValue {
  notify: (message: string, type?: NotifyType) => void;
  notifySuccess: (message: string) => void;
  notifyError: (message: string) => void;
  notifyWarning: (message: string) => void;
  notifyInfo: (message: string) => void;
}

// ─── Context ────────────────────────────────────────────────────────────────────

const NotifyContext = createContext<NotifyContextValue | null>(null);

export const useNotify = (): NotifyContextValue => {
  const ctx = useContext(NotifyContext);
  if (!ctx) throw new Error("useNotify must be used within NotifyProvider");
  return ctx;
};

// ─── Provider ────────────────────────────────────────────────────────────────────

const AUTO_DISMISS_MS = 3500;
const MAX_VISIBLE = 5;

export const NotifyProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const counterRef = useRef(0);

  const add = useCallback((message: string, type: NotifyType) => {
    const id = ++counterRef.current;
    setNotifications(prev => [...prev.slice(-(MAX_VISIBLE - 1)), { id, type, message }]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, AUTO_DISMISS_MS);
  }, []);

  const notify = useCallback((message: string, type: NotifyType = "info") => add(message, type), [add]);
  const notifySuccess = useCallback((message: string) => add(message, "success"), [add]);
  const notifyError = useCallback((message: string) => add(message, "error"), [add]);
  const notifyWarning = useCallback((message: string) => add(message, "warning"), [add]);
  const notifyInfo = useCallback((message: string) => add(message, "info"), [add]);

  const remove = useCallback((id: number) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  return (
    <NotifyContext.Provider value={{ notify, notifySuccess, notifyError, notifyWarning, notifyInfo }}>
      {children}
      <div className="notify-container">
        {notifications.map(n => (
          <div key={n.id} className={`notify-toast notify-${n.type}`} onClick={() => remove(n.id)}>
            <span className="notify-icon">
              {n.type === "success" && <i className="bx bx-check-circle" />}
              {n.type === "error" && <i className="bx bx-error-circle" />}
              {n.type === "warning" && <i className="bx bx-error" />}
              {n.type === "info" && <i className="bx bx-info-circle" />}
            </span>
            <span className="notify-message">{n.message}</span>
          </div>
        ))}
      </div>
    </NotifyContext.Provider>
  );
};
