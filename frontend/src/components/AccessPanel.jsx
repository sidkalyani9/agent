import { useEffect, useState } from "react";
import { api } from "../api.js";

const ROLES = [
  ["office_manager", "Office Manager"],
  ["accounts", "Accounts"],
  ["admin", "Admin"],
  ["super_admin", "Super Admin"],
];

const EMPTY = {
  directoryObjectId: "",
  signInName: "",
  displayName: "",
  role: "office_manager",
  officeId: "",
};

export function AccessPanel({ offices }) {
  const [people, setPeople] = useState([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [issued, setIssued] = useState(null);

  async function load() {
    const data = await api("/api/access");
    setPeople(data.people);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  function choose(person) {
    setForm({
      directoryObjectId: person.directoryObjectId || "",
      signInName: person.signInName || person.email || "",
      displayName: person.displayName || "",
      role: "office_manager",
      officeId: offices[0]?.id || "",
    });
  }

  async function search(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const data = await api(`/api/directory/users?query=${encodeURIComponent(query.trim())}`);
      setResults(data.people);
    } catch (err) {
      setResults([]);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const needsOffice = form.role === "office_manager" || form.role === "accounts";
      await api("/api/access", {
        method: "POST",
        body: {
          directoryObjectId: form.directoryObjectId || undefined,
          signInName: form.signInName,
          displayName: form.displayName,
          role: form.role,
          officeId: needsOffice ? form.officeId : undefined,
        },
      });
      setForm(EMPTY);
      setNotice("Access saved.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeGrant(personId, grantId) {
    setError("");
    try {
      await api(`/api/access/${personId}/grants/${grantId}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function setActive(personId, active) {
    setError("");
    try {
      await api(`/api/access/${personId}/active`, { method: "POST", body: { active } });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function invite(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    setIssued(null);
    setBusy(true);
    try {
      const data = await api("/api/access/invite", {
        method: "POST",
        body: { email: inviteEmail, displayName: inviteName },
      });
      setIssued(data);
      setInviteEmail("");
      setInviteName("");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(issued.temporaryPassword);
      setNotice("Invite password copied.");
    } catch {
      setNotice("Select the invite password and copy it.");
    }
  }

  const needsOffice = form.role === "office_manager" || form.role === "accounts";

  return (
    <section className="card access">
      <div className="card-head">
        <h2>Access</h2>
        <a className="ghost" href="/api/auth/directory">Connect directory search</a>
      </div>
      <p className="lede">Invite an @intuitive.AI email first. Send the one-time password yourself. Then choose what that person can do. Admin can see every office and cannot change records or access.</p>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="notice">{notice}</p> : null}
      <form className="access-form" onSubmit={invite}>
        <label>Name
          <input value={inviteName} onChange={(event) => setInviteName(event.target.value)} placeholder="Optional" />
        </label>
        <label>Email to invite
          <input
            type="email"
            required
            placeholder="name@intuitive.AI"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
          />
        </label>
        <button className="solid" type="submit" disabled={busy}>Invite</button>
      </form>
      {issued ? (
        <div className="invite-secret">
          <p>Send this once to {issued.email}. It will not be shown again. They sign in with it and choose their own password.</p>
          <code>{issued.temporaryPassword}</code>
          <button className="ghost" type="button" onClick={copyPassword}>Copy password</button>
        </div>
      ) : null}

      <form className="access-search" onSubmit={search}>
        <input
          aria-label="Search the company directory"
          placeholder="Search the company directory"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="solid" type="submit" disabled={busy || query.trim().length < 2}>Search</button>
      </form>
      {results ? (
        <div className="person-list">
          {results.map((person) => (
            <button type="button" key={person.directoryObjectId} onClick={() => choose(person)}>
              <span>{person.displayName}</span>
              <small>{person.signInName}</small>
            </button>
          ))}
          {results.length ? null : <p>No @intuitive.AI account matched. Add the sign-in name below.</p>}
        </div>
      ) : null}

      <form className="access-form" onSubmit={save}>
        <label>Name
          <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} required />
        </label>
        <label>Sign-in name
          <input
            type="email"
            placeholder="name@intuitive.AI"
            value={form.signInName}
            onChange={(event) => setForm({ ...form, signInName: event.target.value })}
            required
          />
        </label>
        <label>Role
          <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
            {ROLES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        {needsOffice ? (
          <label>Office
            <select value={form.officeId} onChange={(event) => setForm({ ...form, officeId: event.target.value })} required>
              <option value="">Choose an office</option>
              {offices.map((office) => (
                <option key={office.id} value={office.id}>{office.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <p className="muted">{form.role === "admin" ? "Admin can see every office, and cannot record or change access." : "Super Admin can see every office, add offices, and change access."}</p>
        )}
        <button className="solid" type="submit" disabled={busy}>Save access</button>
      </form>

      <ul className="access-list">
        {people.map((person) => (
          <li key={person.id}>
            <div>
              <strong>{person.displayName}</strong>
              <span>{person.email}</span>
              <span>{person.active ? person.grants.map((grant) => grant.label).join(", ") || "No role yet" : "Turned off"}</span>
              {person.invitePending ? <span>Invite password not used yet</span> : null}
            </div>
            <div className="access-actions">
              {person.grants.map((grant) => (
                <button key={grant.id} className="texty" type="button" onClick={() => removeGrant(person.id, grant.id)}>
                  Remove {grant.label}
                </button>
              ))}
              <button className="texty" type="button" onClick={() => setActive(person.id, !person.active)}>
                {person.active ? "Turn off" : "Turn on"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
