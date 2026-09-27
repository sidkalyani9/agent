import { useEffect, useRef, useState } from "react";
import { api, indiaDate, monthLabel, rupee, setCsrf, statusLabel } from "../api.js";
import { AccessPanel } from "../components/AccessPanel.jsx";
import { ChatDock } from "../components/ChatPanel.jsx";
import { DateRange, OfficeCompare, PantryCharts } from "../components/PantryCharts.jsx";
import { OfficeBar } from "../components/OfficeBar.jsx";
import { RecordPanel } from "../components/RecordPanel.jsx";
import { ProductEditor } from "../components/ProductEditor.jsx";
import { Purchases } from "../components/Purchases.jsx";
import {
  IconAccess,
  IconActivity,
  IconChart,
  IconLogout,
  IconMenu,
  IconMoon,
  IconRecord,
  IconStock,
  IconSun,
  IconSystem,
} from "../icons.jsx";

const NAV = [
  ["record", "Record", IconRecord],
  ["stock", "Stock", IconStock],
  ["charts", "Charts", IconChart],
  ["activity", "Activity", IconActivity],
];

export function Dashboard({ theme, onSignOut }) {
  const [me, setMe] = useState(null);
  const [offices, setOffices] = useState([]);
  const [officeId, setOfficeId] = useState("");
  const [allOffices, setAllOffices] = useState(false);
  const [summary, setSummary] = useState(null);
  const [month, setMonth] = useState("");
  const [pantry, setPantry] = useState(null);
  const [activity, setActivity] = useState([]);
  const [stockQuery, setStockQuery] = useState("");
  const [activityQuery, setActivityQuery] = useState("");
  const [health, setHealth] = useState(null);
  const [view, setView] = useState("stock");
  const [menuOpen, setMenuOpen] = useState(false);
  const [actRange, setActRange] = useState({ from: "", to: "" });
  const [chartRange, setChartRange] = useState({ from: "", to: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const officeRequest = useRef(0);
  const purchaseRequest = useRef(null);

  async function loadOffice(nextOffice, nextMonth, person = me) {
    if (!nextOffice) return;
    const request = ++officeRequest.current;
    const pantryData = await api(`/api/offices/${nextOffice}/pantry?month=${encodeURIComponent(nextMonth)}`);
    if (request !== officeRequest.current) return;
    setPantry(pantryData);
    if (person?.seesEveryOffice) {
      const summaryData = await api(`/api/pantry/summary?month=${encodeURIComponent(nextMonth)}`);
      if (request === officeRequest.current) setSummary(summaryData);
    }
  }

  useEffect(() => {
    const messages = {
      directory_ready: "Directory search is connected.",
      not_configured: "Microsoft sign-in is not configured on this server yet.",
      failed: "That Microsoft step did not complete. Try again.",
    };
    const code = new URLSearchParams(window.location.search).get("auth") || "";
    if (messages[code]) {
      if (code === "directory_ready") setNotice(messages[code]);
      else setError(messages[code]);
    }
    if (code) window.history.replaceState({}, "", "/");
  }, []);

  useEffect(() => {
    let cancel = false;
    Promise.all([api("/api/me"), api("/api/offices")])
      .then(async ([mine, officeData]) => {
        if (cancel) return;
        setCsrf(mine.csrfToken);
        setMe(mine.person);
        setOffices(officeData.offices);
        setHealth({ chatConfigured: mine.chatConfigured });
        const first = officeData.offices[0]?.id || "";
        setOfficeId(first);
        const current = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Kolkata",
          year: "numeric",
          month: "2-digit",
        }).format(new Date());
        setMonth(current);
        if (first) await loadOffice(first, current, mine.person);
      })
      .catch((err) => setError(err.message));
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (!pantry) return;
    const firstMonth = pantry.products.map((product) => product.history?.[0]?.month).filter(Boolean).sort()[0];
    const from = firstMonth ? `${firstMonth}-01` : pantry.today;
    setActRange((current) => (current.from ? current : { from, to: pantry.today }));
    const dates = pantry.products.flatMap((product) => (product.series || []).map((point) => point.date)).sort();
    if (dates.length) {
      setChartRange((current) => (current.from ? current : { from: dates[0], to: dates[dates.length - 1] }));
    }
  }, [pantry]);

  useEffect(() => {
    if (!officeId || !actRange.from || !actRange.to) return undefined;
    let cancel = false;
    api(`/api/offices/${officeId}/operations?from=${encodeURIComponent(actRange.from)}&to=${encodeURIComponent(actRange.to)}`)
      .then((data) => {
        if (!cancel) setActivity(data.operations);
      })
      .catch((err) => {
        if (!cancel) setError(err.message);
      });
    return () => {
      cancel = true;
    };
  }, [officeId, actRange.from, actRange.to]);

  const products = (pantry?.products || []).filter((product) => !product.deletedAt);
  const stockNeedle = stockQuery.trim().toLowerCase();
  const stockList = products.filter((product) => !stockNeedle || product.name.toLowerCase().includes(stockNeedle) || statusLabel(product.status).toLowerCase().includes(stockNeedle));
  const officeList = (summary?.offices || []).filter((office) => !stockNeedle || office.name.toLowerCase().includes(stockNeedle));
  const activityNeedle = activityQuery.trim().toLowerCase();
  const activityList = activity.filter((item) => !activityNeedle || `${item.actor} ${item.summary}`.toLowerCase().includes(activityNeedle));
  const due = products.filter((product) => product.status === "due").map((product) => product.name);
  const forecastSpend = allOffices ? summary?.forecastSpend : pantry?.forecast?.spend;
  const forecastMonth = allOffices ? summary?.forecastMonth : pantry?.forecast?.month;
  const forecastDays = allOffices ? summary?.effectiveDays : pantry?.forecast?.effectiveDays;
  const nav = me?.superAdmin ? [...NAV, ["access", "Access", IconAccess]] : NAV;
  const section = nav.find(([id]) => id === view)?.[1] || "Stock";

  useEffect(() => {
    const node = document.querySelector(".page");
    if (node) node.scrollTop = 0;
  }, [view, officeId]);

  async function refresh() {
    await loadOffice(officeId, month, me);
  }

  async function submit(form, receipt) {
    setBusy(true);
    setError("");
    try {
      if (form.kind === "office") {
        await api("/api/offices", { method: "POST", body: { name: form.name } });
      } else if (form.kind === "product") {
        await api(`/api/offices/${officeId}/products`, { method: "POST", body: { name: form.name } });
      } else if (form.kind === "purchase") {
        const fingerprint = JSON.stringify({ officeId, form, receipt });
        if (purchaseRequest.current?.fingerprint !== fingerprint) purchaseRequest.current = { fingerprint, key: crypto.randomUUID() };
        const saved = await api(`/api/offices/${officeId}/purchases`, {
          method: "POST",
          headers: { "Idempotency-Key": purchaseRequest.current.key },
          body: {
            productId: form.productId,
            date: form.date,
            packs: Number(form.packs),
            pricePerPack: form.price,
            receipt,
          },
        });
        purchaseRequest.current = null;
        if (saved.receiptError) setError(saved.receiptError);
      } else if (form.kind === "count") {
        await api(`/api/offices/${officeId}/counts`, {
          method: "PUT",
          body: { productId: form.productId, date: form.date, packs: Number(form.packs) },
        });
      } else if (form.kind === "settings") {
        await api("/api/settings", {
          method: "PATCH",
          body: { weekendWeight: Number(form.price), lookbackMonths: Number(form.packs) },
        });
      }
      try {
        const officeData = await api("/api/offices");
        setOffices(officeData.offices);
        const nextOffice = officeId || officeData.offices[0]?.id;
        if (!officeId && nextOffice) setOfficeId(nextOffice);
        await loadOffice(nextOffice, month, me);
      } catch {
        // The write was acknowledged. Clear the form even if a subsequent
        // read fails so retrying the display does not record another purchase.
        setError(previous => [previous, "Saved, but the screen could not refresh. Reload to see the updated pantry."].filter(Boolean).join(" "));
      }
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    const blob = await api(`/api/offices/${officeId}/export?month=${encodeURIComponent(month)}`);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${pantry?.officeName || "pantry"}-${month}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function chooseOffice(id) {
    setAllOffices(false);
    setOfficeId(id);
    setPantry(null);
    loadOffice(id, month, me).catch((err) => setError(err.message));
  }

  return (
    <div className="shell">
      <aside className={`side${menuOpen ? " open" : ""}`}>
        <div className="side-scroll">
          <p className="nav-label">Pantry</p>
          <nav aria-label="Pantry">
            {nav.map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                className="nav-item"
                aria-current={view === id ? "page" : undefined}
                onClick={() => {
                  setView(id);
                  setMenuOpen(false);
                }}
              >
                <Icon /> {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="side-bottom">
          <div className="account">
            <span className="avatar" aria-hidden="true">{initials(me?.displayName)}</span>
            <div>
              <strong>{me?.displayName || "…"}</strong>
              <span>{me?.email}</span>
            </div>
          </div>
          <div className="theme-icons" role="group" aria-label="Colour mode">
            <button type="button" aria-label="Light" aria-pressed={theme.choice === "light"} onClick={() => theme.setChoice("light")}><IconSun /></button>
            <button type="button" aria-label="Dark" aria-pressed={theme.choice === "dark"} onClick={() => theme.setChoice("dark")}><IconMoon /></button>
            <button type="button" aria-label="System" aria-pressed={theme.choice === "system"} onClick={() => theme.setChoice("system")}><IconSystem /></button>
          </div>
          <button className="nav-item logout" type="button" onClick={() => onSignOut().catch(() => setError("Log out could not be completed. Check your connection and try again."))}>
            <IconLogout /> Log out
          </button>
        </div>
      </aside>
      {menuOpen ? <button className="backdrop" type="button" aria-label="Close menu" onClick={() => setMenuOpen(false)} /> : null}

      <header className="top">
        <button className="icon-button menu-button" type="button" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
          <IconMenu />
        </button>
        <img className="logo" src="/brand/logo-on-dark.svg" alt="Intuitive" />
        <strong className="section-name">{section}</strong>
        <div className="top-spacer" />
        <div className="controls top-controls">
          <OfficeBar
            offices={offices}
            officeId={officeId}
            allOffices={allOffices}
            seesEveryOffice={Boolean(me?.seesEveryOffice)}
            superAdmin={Boolean(me?.superAdmin)}
            busy={busy}
            onChoose={chooseOffice}
            onAll={() => setAllOffices(true)}
            onCreated={async (office) => {
              const officeData = await api("/api/offices");
              setOffices(officeData.offices);
              if (office?.id) chooseOffice(office.id);
            }}
            onError={setError}
          />
          <input
            className="month"
            aria-label="Month"
            type="month"
            value={month}
            onChange={(event) => {
              setMonth(event.target.value);
              if (officeId) loadOffice(officeId, event.target.value, me).catch((err) => setError(err.message));
            }}
          />
        </div>
      </header>

      <main className="page">
        {error ? <p className="error">{error}</p> : null}
        {notice ? <p className="notice">{notice}</p> : null}

        {view === "access" && me?.superAdmin ? <AccessPanel offices={offices} /> : null}

        {!offices.length && view !== "access" ? (
          <section className="card">
            <h2>No office yet</h2>
            <p className="lede">Add an office from the bar. It starts with Coffee, Milk, Sugar, Tea, and Sticks at zero packs.</p>
          </section>
        ) : null}

        {offices.length > 0 && (view === "stock" || view === "charts") ? (
          <section className="hero">
            <div>
              <p className="eyebrow"><Star /> {month ? monthLabel(month) : "This month"}</p>
              <h1>{allOffices ? summary ? rupee(summary.spend) : "—" : pantry ? rupee(pantry.spend) : "—"}</h1>
              <p>{allOffices ? "All offices, this month" : `${pantry?.officeName || "Pantry"}, this month`}</p>
            </div>
            <div className="hero-forecast">
              <p className="eyebrow">Next month</p>
              <p className="forecast-figure">{forecastSpend ? rupee(forecastSpend) : "Not yet"}</p>
              <p>
                {forecastSpend && forecastMonth
                  ? `${monthLabel(forecastMonth)} · ${forecastDays} effective days, from the burn rate.`
                  : "This is calculated once two months of purchases are on record."}
              </p>
            </div>
            <div className="hero-side">
              <p>{due.length ? `${due.join(", ")} ${due.length === 1 ? "is" : "are"} due.` : "No product is inside the warning window."}</p>
            </div>
          </section>
        ) : null}

        {offices.length > 0 && view === "record" ? (
          allOffices ? (
            <section className="card"><h2>Choose an office</h2><p className="lede">Record applies to one office. Pick it in the bar.</p></section>
          ) : (
            <RecordPanel key={officeId} pantry={pantry} superAdmin={me?.superAdmin} officeName={pantry?.officeName} busy={busy || !pantry} onSubmit={submit} />
          )
        ) : null}

        {offices.length > 0 && view === "stock" ? (
          <section className="card" style={{ marginTop: 18 }}>
            <div className="card-head">
              <h2>{allOffices ? "Offices" : pantry?.officeName || "Pantry"}</h2>
              <div className="row-actions">
                <input
                  className="search"
                  type="text"
                  value={stockQuery}
                  placeholder={allOffices ? "Search offices" : "Search products"}
                  aria-label={allOffices ? "Search offices" : "Search products"}
                  onChange={(event) => setStockQuery(event.target.value)}
                />
                <button className="ghost" type="button" onClick={download} disabled={!officeId || allOffices}>Download month</button>
              </div>
            </div>
            {allOffices && summary ? (
              <div className="products">
                {officeList.length ? officeList.map((office) => (
                  <article className="product" key={office.officeId}>
                    <h3>{office.name}</h3>
                    <p className="stat"><small className="muted">This month</small>{rupee(office.spend)}</p>
                    <p className="stat"><small className="muted">Next month</small>{office.forecastSpend ? rupee(office.forecastSpend) : "Not yet"}</p>
                  </article>
                )) : <p className="note">No office matches that search.</p>}
              </div>
            ) : (
              <div className="products">
                {stockList.length ? stockList.map((product) => (
                  <article className="product" key={product.productId}>
                    <div>
                      <h3>{product.name}</h3>
                      <span className="muted">Entered by {product.createdBy} · {product.createdAtLabel}</span>
                    </div>
                    <p className="stat"><small className="muted">Added</small>{product.packsAdded}</p>
                    <p className="stat">
                      <small className="muted">Spend</small>{rupee(product.spend)}
                      <small className="muted">{product.latestPricePerPack ? `Latest ${rupee(product.latestPricePerPack)}` : "No price this month"}</small>
                    </p>
                    <p className="stat"><small className="muted">On hand</small>{product.onHand}</p>
                    <p className="stat">
                      <small className="muted">Burn / day</small>
                      {product.burnRatePerEffectiveDay || "—"}
                      <small className="muted">{product.expectedDate ? indiaDate(product.expectedDate) : "No expected date"}</small>
                    </p>
                    <span className={`pill ${product.status}`}>{statusLabel(product.status)}</span>
                    {product.message ? <p className="note">{product.message}</p> : null}
                    {pantry.canWrite ? <ProductEditor key={`${product.productId}-${product.name}-${product.reorderLevel}-${product.warningEffectiveDays}`} product={product} onSaved={refresh} /> : null}
                  </article>
                )) : <p className="note">{stockQuery.trim() ? "No product matches that search." : "No products on this pantry."}</p>}
              </div>
            )}
            {!allOffices && pantry ? <Purchases key={`${officeId}-${month}`} officeId={officeId} month={month} revision={pantry} /> : null}
          </section>
        ) : null}

        {offices.length > 0 && view === "charts" ? (
          allOffices && summary ? <OfficeCompare summary={summary} /> : pantry ? (
            <PantryCharts pantry={pantry} range={chartRange} onRange={setChartRange} />
          ) : null
        ) : null}

        {offices.length > 0 && view === "activity" ? (
          <section className="card activity">
            <div className="card-head filter-head">
              <h2>{pantry?.officeName || "Activity"}</h2>
              <div className="row-actions">
                <input
                  className="search"
                  type="text"
                  value={activityQuery}
                  placeholder="Search activity"
                  aria-label="Search activity"
                  onChange={(event) => setActivityQuery(event.target.value)}
                />
                <DateRange range={actRange.from ? actRange : null} onRange={setActRange} label="Activity dates" />
              </div>
            </div>
            <ul>
              {activityList.length ? activityList.map((item) => (
                <li key={item.id}>
                  <span><strong>{item.actor}</strong> · {item.summary}</span>
                  <span className="muted">{item.atLabel}</span>
                </li>
              )) : <li><span>{activityQuery.trim() ? "Nothing matches that search." : "Nothing in these dates."}</span></li>}
            </ul>
          </section>
        ) : null}
      </main>

      <ChatDock configured={health?.chatConfigured} onSaved={refresh} />
    </div>
  );
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase()).join("") || "I";
}

function Star() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 0 14.7 9.3 24 12 14.7 14.7 12 24 9.3 14.7 0 12 9.3 9.3Z" />
    </svg>
  );
}
