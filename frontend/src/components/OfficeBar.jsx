import { useEffect, useRef, useState } from "react";

export function OfficeBar({
  offices,
  officeId,
  allOffices,
  seesEveryOffice,
  onChoose,
  onAll,
  variant = "top",
}) {
  const root = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = offices.find((office) => office.id === officeId);
  const many = offices.length > 1 || seesEveryOffice;
  const label = allOffices ? "All offices" : current?.name || "Office";

  useEffect(() => {
    function close(event) {
      if (!root.current?.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const needle = query.trim().toLowerCase();
  const officeChoices = offices.filter((office) => !needle || office.name.toLowerCase().includes(needle));
  const showAll = seesEveryOffice && (!needle || "all offices".includes(needle));

  return (
    <div className={`office-tools${variant === "side" ? " side-office" : ""}`} ref={root}>
      {many ? (
        <div className="office-pick">
          <button
            className="office-button"
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => {
              setQuery("");
              setOpen((value) => !value);
            }}
          >
            {label}
          </button>
          {open ? (
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
                <button type="button" role="option" aria-selected={allOffices} onClick={() => { onAll(); setOpen(false); }}>
                  All offices
                </button>
              ) : null}
              {officeChoices.map((office) => (
                <button
                  key={office.id}
                  type="button"
                  role="option"
                  aria-selected={!allOffices && office.id === officeId}
                  onClick={() => { onChoose(office.id); setOpen(false); }}
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
    </div>
  );
}
