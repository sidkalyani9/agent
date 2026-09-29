import { useEffect, useState } from "react";
import { api, setCsrf, setUnauthorizedHandler } from "./api.js";
import { Dashboard } from "./screens/Dashboard.jsx";
import { SetPassword, SignIn } from "./screens/SignIn.jsx";

function resolve(choice) {
  if (choice === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return choice === "dark" ? "dark" : "light";
}

export function applyTheme(choice) {
  const mode = resolve(choice);
  document.documentElement.dataset.theme = mode;
  document.documentElement.dataset.themeChoice = choice;
  localStorage.setItem("aim-theme", choice);
  return mode;
}

export function App() {
  const [session, setSession] = useState(null);
  const [setupEmail, setSetupEmail] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [choice, setChoice] = useState(localStorage.getItem("aim-theme") || "light");
  const [mode, setMode] = useState(resolve(localStorage.getItem("aim-theme") || "light"));

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession((current) => {
        if (current === true) setAuthNotice("Your session ended. Sign in again.");
        return false;
      });
      setSetupEmail("");
    });
    api("/api/me")
      .then((data) => {
        setCsrf(data.csrfToken);
        setSetupEmail("");
        setAuthNotice("");
        setSession(true);
      })
      .catch(async () => {
        try {
          const response = await fetch("/api/auth/password/setup", { credentials: "same-origin" });
          if (response.ok) {
            const data = await response.json();
            setSetupEmail(data.email || "");
            setSession(false);
            return;
          }
          const data = await response.json().catch(() => ({}));
          if (response.status === 401 && data.error && data.error !== "Sign in with the invite password first.") setAuthNotice(data.error);
        } catch {
          /* show the sign-in page */
        }
        setSession(false);
      })
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    setMode(applyTheme(choice));
    if (choice !== "system") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setMode(applyTheme("system"));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

  const theme = { choice, setChoice, mode };
  if (!ready) {
    return (
      <main className="sign">
        <section className="sign-panel">
          <p className="lede">Opening the pantry.</p>
        </section>
      </main>
    );
  }
  if (setupEmail) {
    return (
      <SetPassword
        theme={theme}
        email={setupEmail}
        onSuccess={() => {
          setAuthNotice("");
          setSetupEmail("");
          setSession(true);
        }}
      />
    );
  }
  if (!session) {
    return (
      <SignIn
        theme={theme}
        notice={authNotice}
        onSetup={(email) => {
          setAuthNotice("");
          setSetupEmail(email);
        }}
        onSuccess={() => {
          setAuthNotice("");
          setSession(true);
        }}
      />
    );
  }
  return (
    <Dashboard
      theme={theme}
      onSignOut={async () => {
        await api("/api/auth/logout", { method: "POST", body: {} });
        setCsrf("");
        setSession(false);
      }}
    />
  );
}

export function ThemeSwitch({ choice, setChoice }) {
  const options = [
    ["light", "Light"],
    ["dark", "Dark"],
    ["system", "System"],
  ];
  return (
    <div className="theme" role="group" aria-label="Colour mode">
      {options.map(([value, label]) => (
        <button key={value} type="button" aria-pressed={choice === value} onClick={() => setChoice(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Logo({ mode, className = "logo" }) {
  const src = mode === "dark" ? "/brand/logo-on-dark.svg" : "/brand/logo-on-light.svg";
  return <img className={className} src={src} alt="Intuitive" />;
}
