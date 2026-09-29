import { useEffect, useState } from "react";
import { api, setCsrf } from "../api.js";
import { ThemeSwitch } from "../App.jsx";

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

export function SignIn({ theme, onSuccess, onSetup }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

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
      {message ? <p className="error">{message}</p> : null}
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
        <label>Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <button className="solid" type="submit" disabled={busy}>Sign in</button>
      </form>
      <p className="or">or</p>
      <a className="solid microsoft" href="/api/auth/login">Sign in with Microsoft</a>
    </Shell>
  );
}

export function SetPassword({ theme, email, onSuccess }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const matches = password.length > 0 && password === confirm;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const data = await api("/api/auth/password/setup", { method: "POST", body: { password, confirm } });
      setCsrf(data.csrfToken);
      onSuccess();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell theme={theme}>
      <h2>Choose a password</h2>
      <p className="lede">This invite can be used once. Choose the password you will use next time.</p>
      {message ? <p className="error">{message}</p> : null}
      <form className="sign-form" onSubmit={submit}>
        <label>Email
          <input type="email" value={email} readOnly autoComplete="username" />
        </label>
        <label>New password
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <label>Confirm password
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </label>
        <ul className="password-rules">
          <li>At least 12 characters</li>
          <li>An uppercase letter, a lowercase letter, and a number</li>
          <li>Different from the invite password</li>
        </ul>
        <button className="solid" type="submit" disabled={busy || !matches}>Save password</button>
      </form>
    </Shell>
  );
}
