import { useEffect, useRef, useState } from "react";

export function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({ toast, onDismiss }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(4000);
  const started = useRef(0);
  const error = toast.tone === "error";

  useEffect(() => {
    if (error || paused) return undefined;
    started.current = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started.current));
    };
  }, [error, paused, toast.id, onDismiss]);

  return (
    <div
      className={`toast ${error ? "error-toast" : "ok-toast"}`}
      role={error ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <p>{toast.text}</p>
      <button type="button" className="texty" onClick={() => onDismiss(toast.id)}>Close</button>
    </div>
  );
}
