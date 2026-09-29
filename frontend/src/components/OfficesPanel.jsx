import { useEffect, useState } from "react";
import { api } from "../api.js";

export function OfficesPanel({ offices, onChanged, onToast }) {
  const [people, setPeople] = useState([]);
  const [access, setAccess] = useState([]);
  const [name, setName] = useState("");
  const [personId, setPersonId] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [names, setNames] = useState({});
  const [assign, setAssign] = useState({});
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadPeople() {
    const [directory, roster] = await Promise.all([api("/api/people"), api("/api/access")]);
    setPeople(directory.people);
    setAccess(roster.people);
  }

  useEffect(() => {
    loadPeople().catch((err) => setError(err.message));
  }, []);

  const needle = personQuery.trim().toLowerCase();
  const choices = people.filter((person) => !needle || `${person.displayName} ${person.email}`.toLowerCase().includes(needle));

  function managers(officeId) {
    return access.flatMap((person) => (person.grants || [])
      .filter((grant) => grant.role === "office_manager" && grant.officeId === officeId)
      .map((grant) => ({ ...grant, personId: person.id, displayName: person.displayName, email: person.email })));
  }

  async function addOffice(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await api("/api/offices", { method: "POST", body: { name, managerId: personId } });
      setName("");
      setPersonId("");
      setPersonQuery("");
      await onChanged(created);
      await loadPeople();
      onToast?.(`Added ${created.name}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function rename(office) {
    const next = (names[office.id] ?? office.name).trim();
    if (!next || next === office.name) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api(`/api/offices/${office.id}`, { method: "PATCH", body: { name: next } });
      setNames((current) => ({ ...current, [office.id]: saved.name }));
      await onChanged(saved);
      onToast?.(`Renamed the office to ${saved.name}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function assignManager(officeId) {
    const chosen = assign[officeId];
    if (!chosen) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api(`/api/offices/${officeId}/manager`, { method: "POST", body: { personId: chosen } });
      setAssign((current) => ({ ...current, [officeId]: "" }));
      await loadPeople();
      await onChanged();
      onToast?.(`${saved.displayName} is an Office Manager there.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeManager() {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/access/${pending.personId}/grants/${pending.grantId}`, { method: "DELETE" });
      setPending(null);
      await loadPeople();
      await onChanged();
      onToast?.("Office Manager removed.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Offices</h2>
      </div>
      <p className="lede">Add an office, rename it, or choose who records for it. A new office starts with Coffee, Milk, Sugar, Tea, and Sticks.</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <form className="office-form access-form" onSubmit={addOffice}>
        <label>Office name
          <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>Office Manager
          <input
            value={personQuery}
            placeholder="Search people"
            aria-label="Search people"
            onChange={(event) => setPersonQuery(event.target.value)}
          />
        </label>
        <div className="person-list">
          {people.length === 0 && !error ? <p>Loading people.</p> : null}
          {choices.map((person) => (
            <button
              key={person.id}
              type="button"
              aria-pressed={person.id === personId}
              onClick={() => setPersonId(person.id)}
            >
              <span>{person.displayName}</span>
              <small>{person.email}</small>
            </button>
          ))}
          {people.length > 0 && !choices.length ? <p>No person matches that search.</p> : null}
        </div>
        <button className="solid" type="submit" disabled={busy || !name.trim() || !personId}>{busy ? "Saving…" : "Add office"}</button>
      </form>

      <div className="office-list">
        {offices.map((office) => {
          const current = managers(office.id);
          const taken = new Set(current.map((manager) => manager.personId));
          return (
            <article className="office-row" key={office.id}>
              <label>Name
                <input
                  value={names[office.id] ?? office.name}
                  maxLength={80}
                  aria-label={`Name for ${office.name}`}
                  onChange={(event) => setNames((currentNames) => ({ ...currentNames, [office.id]: event.target.value }))}
                />
              </label>
              <button className="ghost" type="button" disabled={busy || (names[office.id] ?? office.name).trim() === office.name} onClick={() => rename(office)}>Rename</button>
              <div>
                <p className="lede-small">Office Managers</p>
                {current.length ? current.map((manager) => (
                  <div className="manager-line" key={manager.id}>
                    <span>{manager.displayName}</span>
                    <button className="texty" type="button" onClick={() => setPending(manager)}>Remove</button>
                  </div>
                )) : <p className="note">No Office Manager yet.</p>}
                {pending && current.some((manager) => manager.id === pending.id) ? (
                  <div className="confirm-card">
                    <p>Remove {pending.displayName} as Office Manager at {office.name}?</p>
                    <div className="row-actions">
                      <button className="solid" type="button" disabled={busy} onClick={removeManager}>Remove manager</button>
                      <button className="ghost" type="button" onClick={() => setPending(null)}>Keep</button>
                    </div>
                  </div>
                ) : null}
                <label>Add an Office Manager
                  <select
                    value={assign[office.id] || ""}
                    aria-label={`Add an Office Manager at ${office.name}`}
                    onChange={(event) => setAssign((currentAssign) => ({ ...currentAssign, [office.id]: event.target.value }))}
                  >
                    <option value="">Choose a person</option>
                    {people.filter((person) => !taken.has(person.id)).map((person) => (
                      <option key={person.id} value={person.id}>{person.displayName}</option>
                    ))}
                  </select>
                </label>
                <button className="ghost" type="button" disabled={busy || !assign[office.id]} onClick={() => assignManager(office.id)}>Assign</button>
              </div>
            </article>
          );
        })}
        {!offices.length ? <p className="note">No office yet.</p> : null}
      </div>
    </section>
  );
}
