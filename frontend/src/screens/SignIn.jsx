import { useEffect, useState } from "react";
import { api, setCsrf } from "../api.js";
import { ThemeSwitch } from "../App.jsx";
import { IconMicrosoft } from "../icons.jsx";

const AUTH_MESSAGES = {
  not_configured: "Microsoft sign-in is not configured on this server yet. You can still sign in with an invited email.",
  not_on_list: "This Microsoft account is not invited. A Super Admin has to invite it first.",
  inactive: "This account is turned off. A Super Admin can turn it back on.",
  domain: "Only an @intuitive.AI account can open this pantry.",
  cancelled: "Microsoft sign-in was cancelled.",
  expired: "That sign-in attempt expired. Try again.",
  failed: "Microsoft sign-in did not complete. Try again.",
  directory_ready: "Directory search is connected. Sign in again if the pantry did not open.",
};

function Shell({ theme, children }) {
  return (
    <main className="sign">
      <section className="sign-hero">
        <img src="/brand/logo-on-dark.svg" alt="Intuitive" />
        <div>
          <p className="sign-kicker">Accounts and inventory</p>
          <h1>Pantry, office by office.</h1>
          <p>What was bought, what it cost this month, and when the next pack is due.</p>
        </div>
      </section>
      <section className="sign-panel">
        <div className="sign-top">
          <ThemeSwitch choice={theme.choice} setChoice={theme.setChoice} />
        </div>
        {children}
      </section>
    </main>
  );
}

export function SignIn({ theme, onSuccess, onSetup, notice = "" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState(notice);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (notice) setMessage(notice);
  }, [notice]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("auth") || "";
    if (AUTH_MESSAGES[code]) setMessage(AUTH_MESSAGES[code]);
    if (code) window.history.replaceState({}, "", "/");
  }, []);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const data = await api("/api/auth/password", { method: "POST", body: { email, password } });
      if (data.next === "setup") onSetup(data.email);
      else {
        setCsrf(data.csrfToken);
        onSuccess();
      }
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell theme={theme}>
      <h2>Sign in</h2>
      <p className="lede">Use the email a Super Admin invited, or your Intuitive Microsoft account.</p>
      {message ? <p className="error" role="alert">{message}</p> : null}
      <form className="sign-form" onSubmit={submit}>
        <label>Email
          <input
            type="email"
            autoComplete="username"
            placeholder="name@intuitive.AI"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <div className="secret-row">
          <label htmlFor="sign-password">Password</label>
          <span className="secret-field">
            <input
              id="sign-password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <button type="button" className="texty" aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>
              {showPassword ? "Hide" : "Show"}
            </button>
          </span>
        </div>
        <button className="solid" type="submit" disabled={busy} aria-busy={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="or">or</p>
      <a className="solid microsoft" href="/api/auth/login"><IconMicrosoft /> Sign in with Microsoft</a>
      <p className="lede-small">A Super Admin can send a new invite if you cannot sign in.</p>
    </Shell>
  );
}

function passwordRules(password) {
  return [
    { id: "length", label: "At least 12 characters", ok: password.length >= 12 && password.length <= 128 },
    { id: "mix", label: "An uppercase letter, a lowercase letter, and a number", ok: /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password) },
    { id: "invite", label: "Different from the invite password", ok: null },
  ];
}

export function SetPassword({ theme, email, onSuccess }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [inviteRejected, setInviteRejected] = useState(false);
  const [busy, setBusy] = useState(false);
  const started = password.length > 0;
  const rules = passwordRules(password).map((rule) => {
    if (rule.id === "invite") return { ...rule, ok: inviteRejected ? false : null };
    return { ...rule, ok: started ? rule.ok : null };
  });

  async function submit(event) {
    event.preventDefault();
    setMessage("");
    setInviteRejected(false);
    if (password !== confirm) {
      setMessage("Those passwords do not match.");
      return;
    }
    const unmet = passwordRules(password).filter((rule) => rule.ok === false);
    if (unmet.length) {
      setMessage(unmet.map((rule) => rule.label).join(" "));
      return;
    }
    setBusy(true);
    try {
      const data = await api("/api/auth/password/setup", { method: "POST", body: { password, confirm } });
      setCsrf(data.csrfToken);
      onSuccess();
    } catch (err) {
      setMessage(err.message);
      if (/invite password/i.test(err.message)) setInviteRejected(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell theme={theme}>
      <h2>Choose a password</h2>
      <p className="lede">This invite can be used once. Choose the password you will use next time.</p>
      {message ? <p className="error" role="alert">{message}</p> : null}
      <form className="sign-form" onSubmit={submit}>
        <label>Email
          <input type="email" value={email} readOnly autoComplete="username" />
        </label>
        <div className="secret-row">
          <label htmlFor="new-password">New password</label>
          <span className="secret-field">
            <input
              id="new-password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              value={password}
              aria-invalid={Boolean(message)}
              onChange={(event) => {
                setPassword(event.target.value);
                setInviteRejected(false);
              }}
              required
            />
            <button type="button" className="texty" aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>
              {showPassword ? "Hide" : "Show"}
            </button>
          </span>
        </div>
        <label>Confirm password
          <input
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={confirm}
            aria-invalid={password !== confirm && confirm.length > 0}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </label>
        <ul className="password-rules">
          {rules.map((rule) => (
            <li key={rule.id} className={rule.ok === true ? "rule-met" : rule.ok === false ? "rule-miss" : ""}>
              {rule.label}
            </li>
          ))}
          <li className={confirm && password !== confirm ? "rule-miss" : password && password === confirm ? "rule-met" : ""}>
            Confirm password matches
          </li>
        </ul>
        <button className="solid" type="submit" disabled={busy} aria-busy={busy}>{busy ? "Saving…" : "Save password"}</button>
      </form>
    </Shell>
  );
}
