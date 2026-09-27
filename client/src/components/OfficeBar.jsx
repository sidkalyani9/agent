import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

export function OfficeBar({
  offices,
  officeId,
  allOffices,
  seesEveryOffice,
  superAdmin,
  busy,
  onChoose,
  onAll,
  onCreated,
  onError,
}) {
  const root = useRef(null);
  const [open, setOpen] = useState("");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState([]);
  const [name, setName] = useState("");
  const [personId, setPersonId] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const current = offices.find((office) => office.id === officeId);
  const many = offices.length > 1 || seesEveryOffice;
  const label = allOffices ? "All offices" : current?.name || "Office";

  useEffect(() => {
    function close(event) {
      if (!root.current?.contains(event.target)) setOpen("");
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    if ((open !== "add" && open !== "assign") || !superAdmin) return undefined;
    let cancel = false;
    api("/api/people")
      .then((data) => {
        if (!cancel) setPeople(data.people);
      })
      .catch((err) => onError(err.message));
    return () => {
      cancel = true;
    };
  }, [open, superAdmin, onError]);

  const needle = query.trim().toLowerCase();
  const officeChoices = offices.filter((office) => !needle || office.name.toLowerCase().includes(needle));
  const showAll = seesEveryOffice && (!needle || "all offices".includes(needle));
  const personNeedle = personQuery.trim().toLowerCase();
  const personChoices = people.filter((person) => {
    if (!personNeedle) return true;
    return `${person.displayName} ${person.email}`.toLowerCase().includes(personNeedle);
  });

  function resetForm() {
    setName("");
    setPersonId("");
    setPersonQuery("");
  }

  async function addOffice(event) {
    event.preventDefault();
    try {
      const created = await api("/api/offices", { method: "POST", body: { name, managerId: personId } });
      resetForm();
      setOpen("");
      await onCreated(created);
    } catch (err) {
      onError(err.message);
    }
  }

  async function assignManager(event) {
    event.preventDefault();
    try {
      await api(`/api/offices/${officeId}/manager`, { method: "POST", body: { personId } });
      resetForm();
      setOpen("");
      await onCreated(current);
    } catch (err) {
      onError(err.message);
    }
  }

  return (
    <div className="office-tools" ref={root}>
      {many ? (
        <div className="office-pick">
          <button
            className="office-button"
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open === "pick"}
            onClick={() => {
              setQuery("");
              setOpen((value) => (value === "pick" ? "" : "pick"));
            }}
          >
            {label}
          </button>
          {open === "pick" ? (
            <div className="office-menu" role="listbox" aria-label="Offices">
              <input
                className="office-search"
                type="text"
                value={query}
                placeholder="Search offices"
                aria-label="Search offices"
                onChange={(event) => setQuery(event.target.value)}
                autoFocus
              />
              {showAll ? (
                <button type="button" role="option" aria-selected={allOffices} onClick={() => { onAll(); setOpen(""); }}>
                  All offices
                </button>
              ) : null}
              {officeChoices.map((office) => (
                <button
                  key={office.id}
                  type="button"
                  role="option"
                  aria-selected={!allOffices && office.id === officeId}
                  onClick={() => { onChoose(office.id); setOpen(""); }}
                >
                  {office.name}
                </button>
              ))}
              {!showAll && !officeChoices.length ? <p>No office matches that search.</p> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <span className="office-label">{label}</span>
      )}
      {superAdmin ? (
        <button className="office-button" type="button" onClick={() => { resetForm(); setOpen((value) => (value === "add" ? "" : "add")); }}>
          Add office
        </button>
      ) : null}
      {superAdmin && officeId && !allOffices ? (
        <button className="office-button" type="button" onClick={() => { resetForm(); setOpen((value) => (value === "assign" ? "" : "assign")); }}>
          Assign manager
        </button>
      ) : null}
      {open === "add" || open === "assign" ? (
        <form className="office-menu office-form" onSubmit={open === "add" ? addOffice : assignManager}>
          <strong>{open === "add" ? "Add an office" : `Office Manager at ${current?.name || "this office"}`}</strong>
          {open === "add" ? (
            <label>Office name
              <input value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
          ) : (
            <p>Choose a person. They can record for this office, and they keep any other office they already have.</p>
          )}
          <label>Office Manager
            <input
              value={personQuery}
              placeholder="Search people"
              aria-label="Search people"
              onChange={(event) => setPersonQuery(event.target.value)}
            />
          </label>
          <div className="person-list">
            {personChoices.map((person) => {
              const already = open === "assign" && person.managerOf?.includes(officeId);
              return (
                <button
                  key={person.id}
                  type="button"
                  aria-pressed={person.id === personId}
                  disabled={already}
                  onClick={() => setPersonId(person.id)}
                >
                  <span>{person.displayName}</span>
                  <small>{already ? "Already Office Manager here" : person.email}</small>
                </button>
              );
            })}
            {personChoices.length ? null : <p>No person matches that search.</p>}
          </div>
          <button className="solid" type="submit" disabled={busy || !personId || (open === "add" && !name.trim())}>
            {open === "add" ? "Add office" : "Assign"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
