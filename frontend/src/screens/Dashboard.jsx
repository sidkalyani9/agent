import { useCallback, useEffect, useRef, useState } from "react";
import { api, indiaDate, monthLabel, packs, rupee, setCsrf, statusLabel } from "../api.js";
import { AccessPanel } from "../components/AccessPanel.jsx";
import { ChatDock } from "../components/ChatPanel.jsx";
import { DateRange, OfficeCompare, PantryCharts } from "../components/PantryCharts.jsx";
import { OfficeBar } from "../components/OfficeBar.jsx";
import { OfficesPanel } from "../components/OfficesPanel.jsx";
import { RecordPanel } from "../components/RecordPanel.jsx";
import { ProductEditor } from "../components/ProductEditor.jsx";
import { Purchases } from "../components/Purchases.jsx";
import { SettingsPanel } from "../components/SettingsPanel.jsx";
import { ToastStack } from "../components/Toasts.jsx";
import {
  IconAccess,
  IconActivity,
  IconChart,
  IconChevron,
  IconLogout,
  IconMenu,
  IconMoon,
  IconOffice,
  IconRecord,
  IconSettings,
  IconStock,
  IconSun,
  IconSystem,
} from "../icons.jsx";

const PANTRY_VIEWS = ["record", "stock", "charts", "activity"];
const ADMIN_VIEWS = ["offices", "access", "settings"];
const PANTRY_NAV = [
  ["record", "Record", IconRecord],
  ["stock", "Stock", IconStock],
  ["charts", "Charts", IconChart],
  ["activity", "Activity", IconActivity],
];
const ADMIN_NAV = [
  ["offices", "Offices", IconOffice],
  ["access", "Access", IconAccess],
  ["settings", "Settings", IconSettings],
];
const TITLES = {
  record: "Record",
  stock: "Stock",
  charts: "Charts",
  activity: "Activity",
  offices: "Offices",
  access: "Access",
  settings: "Settings",
};

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const month = params.get("month") || "";
  return {
    view: params.get("view") || "stock",
    office: params.get("office") || "",
    month: /^\d{4}-\d{2}$/.test(month) ? month : "",
  };
}

function indiaMonth(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  }).format(date);
}

function allowedView(view, person) {
  if (PANTRY_VIEWS.includes(view)) return view;
  if (person?.superAdmin && ADMIN_VIEWS.includes(view)) return view;
  return "stock";
}

function safeMonth(value) {
  return /^\d{4}-\d{2}$/.test(value || "") ? monthLabel(value) : "this month";
}

function showSummary(summary) {
  return String(summary || "").replace(/\b(20\d{2}-\d{2}-\d{2})\b/g, (iso) => indiaDate(iso));
}

function roleLine(person) {
  if (!person) return "";
  if (person.superAdmin) return "Super Admin";
  if (person.admin) return "Admin";
  const grants = person.grants || [];
  const managers = grants.filter((grant) => grant.role === "office_manager" && grant.officeName);
  if (managers.length) return `Office Manager · ${managers.map((grant) => grant.officeName).join(", ")}`;
  const accounts = grants.filter((grant) => grant.role === "accounts" && grant.officeName);
  if (accounts.length) return `Accounts · ${accounts.map((grant) => grant.officeName).join(", ")}`;
  return "No role yet";
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase()).join("") || "I";
}

export function Dashboard({ theme, onSignOut }) {
  const starting = useRef(readLocation());
  const [me, setMe] = useState(null);
  const [offices, setOffices] = useState([]);
  const [officesReady, setOfficesReady] = useState(false);
  const [booted, setBooted] = useState(false);
  const [officeId, setOfficeId] = useState("");
  const [allOffices, setAllOffices] = useState(false);
  const [summary, setSummary] = useState(null);
  const [month, setMonth] = useState(starting.current.month);
  const [pantry, setPantry] = useState(null);
  const [pantryLoading, setPantryLoading] = useState(false);
  const [activity, setActivity] = useState(null);
  const [stockQuery, setStockQuery] = useState("");
  const [activityQuery, setActivityQuery] = useState("");
  const [health, setHealth] = useState(null);
  const [view, setView] = useState(() => (PANTRY_VIEWS.includes(starting.current.view) ? starting.current.view : "stock"));
  const [groups, setGroups] = useState({ pantry: true, admin: true });
  const [menuOpen, setMenuOpen] = useState(false);
  const [actRange, setActRange] = useState({ from: "", to: "" });
  const [chartRange, setChartRange] = useState({ from: "", to: "" });
  const [error, setError] = useState("");
  const [toasts, setToasts] = useState([]);
  const [busy, setBusy] = useState(false);
  const officeRequest = useRef(0);
  const purchaseRequest = useRef(null);

  const dismissToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((text, tone = "ok") => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-4), { id, text, tone }]);
  }, []);

  async function loadOffice(nextOffice, nextMonth, person = me) {
    if (!nextOffice) return;
    const request = ++officeRequest.current;
    setPantryLoading(true);
    try {
      const pantryData = await api(`/api/offices/${nextOffice}/pantry?month=${encodeURIComponent(nextMonth)}`);
      if (request !== officeRequest.current) return;
      setPantry(pantryData);
      setPantryLoading(false);
      if (person?.seesEveryOffice) {
        const summaryData = await api(`/api/pantry/summary?month=${encodeURIComponent(nextMonth)}`);
        if (request === officeRequest.current) setSummary(summaryData);
      } else if (request === officeRequest.current) {
        setSummary(null);
      }
    } finally {
      if (request === officeRequest.current) setPantryLoading(false);
    }
  }

  async function reloadScreen(nextOffice = officeId, nextMonth = month, person = me) {
    const officeData = await api("/api/offices");
    setOffices(officeData.offices);
    const known = officeData.offices.some((office) => office.id === nextOffice);
    const resolved = known ? nextOffice : officeData.offices[0]?.id || "";
    if (!known) {
      setAllOffices(false);
      setOfficeId(resolved);
    }
    if (resolved) await loadOffice(resolved, nextMonth, person);
    return officeData;
  }

  useEffect(() => {
    const messages = {
      directory_ready: "Directory search is connected.",
      not_configured: "Microsoft sign-in is not configured on this server yet.",
      failed: "That Microsoft step did not complete. Try again.",
    };
    const params = new URLSearchParams(window.location.search);
    const code = params.get("auth") || "";
    if (messages[code]) {
      if (code === "directory_ready") pushToast(messages[code]);
      else setError(messages[code]);
    }
    if (code) {
      params.delete("auth");
      const qs = params.toString();
      window.history.replaceState({}, "", qs ? `/?${qs}` : "/");
    }
    let cancel = false;
    Promise.all([api("/api/me"), api("/api/offices")])
      .then(async ([mine, officeData]) => {
        if (cancel) return;
        setCsrf(mine.csrfToken);
        setMe(mine.person);
        setOffices(officeData.offices);
        setHealth({ chatConfigured: mine.chatConfigured });
        const wanted = starting.current;
        const nextView = allowedView(wanted.view, mine.person);
        setView(nextView);
        const currentMonth = wanted.month || indiaMonth();
        setMonth(currentMonth);
        const list = officeData.offices;
        let nextAll = false;
        let nextId = "";
        if (wanted.office === "all" && mine.person.seesEveryOffice) {
          nextAll = true;
          nextId = list[0]?.id || "";
        } else if (list.some((office) => office.id === wanted.office)) {
          nextId = wanted.office;
        } else {
          nextId = list[0]?.id || "";
        }
        setAllOffices(nextAll);
        setOfficeId(nextId);
        setOfficesReady(true);
        setBooted(true);
        if (nextId) {
          try {
            await loadOffice(nextId, currentMonth, mine.person);
          } catch (err) {
            if (!cancel) setError(err.message);
          }
        }
      })
      .catch((err) => {
        if (cancel) return;
        setError(err.message);
        setOfficesReady(true);
        setBooted(true);
      });
    return () => {
      cancel = true;
    };
  }, [pushToast]);

  useEffect(() => {
    if (!booted) return;
    const params = new URLSearchParams();
    if (view !== "stock") params.set("view", view);
    if (allOffices && me?.seesEveryOffice) params.set("office", "all");
    else if (officeId) params.set("office", officeId);
    if (/^\d{4}-\d{2}$/.test(month)) params.set("month", month);
    const next = params.toString() ? `/?${params}` : "/";
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== next) window.history.replaceState({}, "", next);
  }, [booted, view, allOffices, officeId, month, me]);

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
    setActivity(null);
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

  useEffect(() => {
    setActRange({ from: "", to: "" });
    setChartRange({ from: "", to: "" });
    setActivity(null);
  }, [officeId]);

  useEffect(() => {
    const node = document.querySelector(".page");
    if (node) node.scrollTop = 0;
  }, [view, officeId]);

  const products = (pantry?.products || []).filter((product) => !product.deletedAt);
  const stockNeedle = stockQuery.trim().toLowerCase();
  const stockList = products.filter((product) => !stockNeedle || product.name.toLowerCase().includes(stockNeedle) || statusLabel(product.status).toLowerCase().includes(stockNeedle));
  const officeList = (summary?.offices || []).filter((office) => !stockNeedle || office.name.toLowerCase().includes(stockNeedle));
  const activityNeedle = activityQuery.trim().toLowerCase();
  const activityList = (activity || []).filter((item) => !activityNeedle || `${item.actor} ${item.summary}`.toLowerCase().includes(activityNeedle));
  const due = products.filter((product) => product.status === "due");
  const forecastSpend = allOffices ? summary?.forecastSpend : pantry?.forecast?.spend;
  const forecastMonth = allOffices ? summary?.forecastMonth : pantry?.forecast?.month;
  const forecastDays = allOffices ? summary?.effectiveDays : pantry?.forecast?.effectiveDays;
  const selectedOffice = offices.find((office) => office.id === officeId);
  const officeName = allOffices ? "All offices" : selectedOffice?.name || pantry?.officeName || "Office";
  const activityOffice = selectedOffice?.name || pantry?.officeName || "this office";
  const heroReady = allOffices ? Boolean(summary) : Boolean(pantry);
  const section = TITLES[view] || "Stock";
  const monthName = safeMonth(month);

  function openView(next) {
    setView(next);
    setError("");
    setMenuOpen(false);
  }

  async function refresh() {
    if (officeId) await loadOffice(officeId, month, me);
  }

  async function officesChanged(office) {
    const officeData = await api("/api/offices");
    setOffices(officeData.offices);
    if (office?.id) {
      setView("stock");
      setAllOffices(false);
      setOfficeId(office.id);
      setPantry(null);
      setSummary(null);
      await loadOffice(office.id, month, me);
      return;
    }
    if (officeId) await loadOffice(officeId, month, me);
  }

  async function submit(form, receipt) {
    setBusy(true);
    setError("");
    try {
      let toast = "";
      if (form.kind === "attach") {
        await api(`/api/purchases/${form.purchaseId}/receipt`, { method: "PUT", body: { receipt } });
        purchaseRequest.current = null;
        toast = "Receipt attached.";
      } else if (form.kind === "product") {
        await api(`/api/offices/${officeId}/products`, { method: "POST", body: { name: form.name } });
        toast = `Added ${form.name}.`;
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
        if (saved.receiptError) {
          setError(saved.receiptError);
          try {
            await reloadScreen();
          } catch {
            setError((previous) => [previous, "Saved, but the screen could not refresh. Reload to see the updated pantry."].filter(Boolean).join(" "));
          }
          return { purchaseId: saved.purchaseId };
        }
        purchaseRequest.current = null;
        toast = "Purchase saved.";
      } else if (form.kind === "count") {
        await api(`/api/offices/${officeId}/counts`, {
          method: "PUT",
          body: { productId: form.productId, date: form.date, packs: Number(form.packs) },
        });
        toast = "Count saved.";
      }
      try {
        await reloadScreen();
      } catch {
        setError("Saved, but the screen could not refresh. Reload to see the updated pantry.");
      }
      if (toast) pushToast(toast);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setError("");
    try {
      const blob = await api(`/api/offices/${officeId}/export?month=${encodeURIComponent(month)}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${pantry?.officeName || "pantry"}-${month}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    }
  }

  function chooseOffice(id) {
    setAllOffices(false);
    setOfficeId(id);
    setPantry(null);
    setSummary(null);
    setError("");
    loadOffice(id, month, me).catch((err) => setError(err.message));
  }

  function chooseAll() {
    setAllOffices(true);
    setError("");
    if (officeId) loadOffice(officeId, month, me).catch((err) => setError(err.message));
  }

  function changeMonth(next) {
    setMonth(next);
    setPantry(null);
    setSummary(null);
    if (officeId) loadOffice(officeId, next, me).catch((err) => setError(err.message));
  }

  return (
    <div className="shell">
      <aside className={`side${menuOpen ? " open" : ""}`}>
        <div className="side-scroll">
          <div className="nav-group">
            <button
              className="nav-parent"
              type="button"
              aria-expanded={groups.pantry}
              onClick={() => setGroups((current) => ({ ...current, pantry: !current.pantry }))}
            >
              <span className="chevron"><IconChevron /></span>
              Pantry
            </button>
            {groups.pantry ? (
              <div className="nav-sub">
                {PANTRY_NAV.map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    className="nav-item"
                    aria-current={view === id ? "page" : undefined}
                    onClick={() => openView(id)}
                  >
                    <Icon /> {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {me?.superAdmin ? (
            <div className="nav-group">
              <button
                className="nav-parent"
                type="button"
                aria-expanded={groups.admin}
                onClick={() => setGroups((current) => ({ ...current, admin: !current.admin }))}
              >
                <span className="chevron"><IconChevron /></span>
                Super Admin
              </button>
              {groups.admin ? (
                <div className="nav-sub">
                  {ADMIN_NAV.map(([id, label, Icon]) => (
                    <button
                      key={id}
                      type="button"
                      className="nav-item"
                      aria-current={view === id ? "page" : undefined}
                      onClick={() => openView(id)}
                    >
                      <Icon /> {label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="side-bottom">
          <OfficeBar
            offices={offices}
            officeId={officeId}
            allOffices={allOffices}
            seesEveryOffice={Boolean(me?.seesEveryOffice)}
            onChoose={chooseOffice}
            onAll={chooseAll}
            variant="side"
          />
          <div className="account">
            <span className="avatar" aria-hidden="true">{initials(me?.displayName)}</span>
            <div>
              <strong>{me?.displayName || "…"}</strong>
              <span>{me?.email}</span>
              {me ? <span className="role-line">{roleLine(me)}</span> : null}
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
        <span className="office-echo">{officeName}</span>
        <div className="top-spacer" />
        <div className="controls top-controls">
          <input
            className="month"
            aria-label="Month"
            type="month"
            value={month}
            onChange={(event) => changeMonth(event.target.value)}
          />
        </div>
      </header>

      <main className="page">
        {error ? (
          <div className="error page-alert" role="alert">
            <span>{error}</span>
            <button className="texty" type="button" onClick={() => setError("")}>Dismiss</button>
          </div>
        ) : null}

        {!officesReady ? <p className="lede">Loading the pantry.</p> : null}

        {officesReady && !offices.length && !ADMIN_VIEWS.includes(view) ? (
          <section className="card">
            <h2>No office yet</h2>
            <p className="lede">
              {me?.superAdmin
                ? "Add an office from Offices. It starts with Coffee, Milk, Sugar, Tea, and Sticks at zero packs."
                : "No office is assigned to this sign-in."}
            </p>
          </section>
        ) : null}

        {view === "offices" && me?.superAdmin ? (
          <OfficesPanel offices={offices} onChanged={officesChanged} onToast={pushToast} />
        ) : null}
        {view === "access" && me?.superAdmin ? <AccessPanel offices={offices} onToast={pushToast} /> : null}
        {view === "settings" && me?.superAdmin ? (
          <SettingsPanel settings={pantry?.settings} onSaved={refresh} onToast={pushToast} />
        ) : null}

        {offices.length > 0 && (view === "stock" || view === "charts") ? (
          heroReady ? (
            <section className="hero">
              <div>
                <p className="eyebrow"><Star /> Spent in {monthName}</p>
                <h1>{allOffices ? rupee(summary.spend) : rupee(pantry.spend)}</h1>
                <p>{allOffices ? "All offices" : pantry.officeName}</p>
              </div>
              <div className="hero-forecast">
                <p className="eyebrow">Next month</p>
                <p className="forecast-figure">{forecastSpend ? rupee(forecastSpend) : "Not yet"}</p>
                <p>
                  {forecastSpend && forecastMonth
                    ? `${monthLabel(forecastMonth)} from today's burn rate. ${forecastDays} effective days.`
                    : "This is calculated once two months of purchases are on record."}
                </p>
              </div>
              <div className="hero-side">
                {allOffices ? (
                  <p>Due stays on each office.</p>
                ) : (
                  <p>{due.length ? `${due.map((product) => product.name).join(", ")} ${due.length === 1 ? "is" : "are"} due.` : "No product is inside the warning window."}</p>
                )}
              </div>
            </section>
          ) : !error ? (
            <section className="card"><p className="lede">Loading {monthName}.</p></section>
          ) : null
        ) : null}

        {offices.length > 0 && view === "record" ? (
          allOffices ? (
            <section className="card"><h2>Choose an office</h2><p className="lede">Record applies to one office. Pick it above your name.</p></section>
          ) : (
            <RecordPanel
              key={officeId}
              pantry={pantry}
              officeId={officeId}
              officeName={selectedOffice?.name || pantry?.officeName}
              superAdmin={Boolean(me?.superAdmin)}
              busy={busy}
              loading={!pantry}
              onSubmit={submit}
              onSaved={refresh}
              onToast={pushToast}
            />
          )
        ) : null}

        {offices.length > 0 && view === "stock" ? (
          <section className="card" style={{ marginTop: 18 }}>
            <div className="card-head">
              <h2>{allOffices ? "Offices" : pantry?.officeName || officeName}</h2>
              <div className="row-actions">
                <input
                  className="search"
                  type="text"
                  value={stockQuery}
                  placeholder={allOffices ? "Search offices" : "Search products"}
                  aria-label={allOffices ? "Search offices" : "Search products"}
                  onChange={(event) => setStockQuery(event.target.value)}
                />
                <button
                  className="ghost"
                  type="button"
                  onClick={download}
                  disabled={!officeId || allOffices || pantryLoading}
                  title={allOffices ? "Pick one office" : undefined}
                >
                  Download month
                </button>
              </div>
            </div>
            {allOffices ? <p className="note">Pick one office to download the month.</p> : null}
            {allOffices ? (
              summary ? (
              <div className="products">
                {officeList.length ? officeList.map((office) => (
                  <button className="product office-card" type="button" key={office.officeId} onClick={() => chooseOffice(office.officeId)}>
                    <h3>{office.name}</h3>
                    <p className="stat"><small className="muted">Spent in {monthName}</small>{rupee(office.spend)}</p>
                    <p className="stat"><small className="muted">Next month</small>{office.forecastSpend ? rupee(office.forecastSpend) : "Not yet"}</p>
                  </button>
                )) : <p className="note">No office matches that search.</p>}
              </div>
              ) : !error ? <p className="note">Loading offices.</p> : null
            ) : !pantry ? (
              <p className="note">Loading {officeName}.</p>
            ) : (
              <div className="products">
                {stockList.length ? stockList.map((product) => (
                  <article className="product" key={product.productId}>
                    <div>
                      <h3>{product.name}</h3>
                      <span className="muted">Entered by {product.createdBy} · {product.createdAtLabel}</span>
                    </div>
                    <p className="stat"><small className="muted">Added in {monthName}</small>{packs(product.packsAdded)}</p>
                    <p className="stat">
                      <small className="muted">Spent in {monthName}</small>{rupee(product.spend)}
                      <small className="muted">{product.latestPricePerPack ? `Latest ${rupee(product.latestPricePerPack)}` : "No price this month"}</small>
                    </p>
                    <p className="stat"><small className="muted">On hand today</small>{packs(product.onHand)}</p>
                    <p className="stat">
                      <small className="muted">Burn / day</small>
                      {product.burnRatePerEffectiveDay || "—"}
                      <small className="muted">{product.expectedDate ? indiaDate(product.expectedDate) : "No expected date"}</small>
                    </p>
                    <span className={`pill ${product.status}`}>{statusLabel(product.status)}</span>
                    <small className="muted reorder-note">
                      {product.status === "due"
                        ? `Due · reorder at ${packs(product.reorderLevel)}`
                        : `Reorder at ${packs(product.reorderLevel)}`}
                    </small>
                    {product.message ? <p className="note">{product.message}</p> : null}
                    {pantry.canWrite ? (
                      <ProductEditor
                        key={`${product.productId}-${product.name}-${product.reorderLevel}-${product.warningEffectiveDays}`}
                        product={product}
                        onSaved={refresh}
                        onToast={pushToast}
                      />
                    ) : null}
                  </article>
                )) : <p className="note">{stockQuery.trim() ? "No product matches that search." : "No products on this pantry."}</p>}
              </div>
            )}
            {!allOffices && pantry ? (
              <Purchases
                key={`${officeId}-${month}`}
                officeId={officeId}
                month={month}
                revision={pantry}
                canWrite={Boolean(pantry.canWrite)}
                onChanged={refresh}
                onToast={pushToast}
              />
            ) : null}
          </section>
        ) : null}

        {offices.length > 0 && view === "charts" ? (
          allOffices ? (
            summary ? <OfficeCompare summary={summary} /> : !error ? <p className="lede">Loading charts.</p> : null
          ) : pantry ? (
            <PantryCharts pantry={pantry} range={chartRange} onRange={setChartRange} />
          ) : !error ? <p className="lede">Loading charts.</p> : null
        ) : null}

        {offices.length > 0 && view === "activity" ? (
          <section className="card activity">
            <div className="card-head filter-head">
              <div>
                <h2>Activity for {activityOffice}</h2>
                {allOffices ? <p className="lede-small">All offices is the total on Stock. This list is {activityOffice}.</p> : null}
              </div>
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
            {activity?.length === 300 ? <p className="note">This list stops at 300 rows.</p> : null}
            <ul>
              {activity === null ? <li><span>Loading activity.</span></li> : activityList.length ? activityList.map((item) => (
                <li key={item.id}>
                  <span><strong>{item.actor}</strong> · {showSummary(item.summary)}</span>
                  <span className="muted">{item.atLabel}</span>
                </li>
              )) : <li><span>{activityQuery.trim() ? "Nothing matches that search." : "Nothing in these dates."}</span></li>}
            </ul>
          </section>
        ) : null}
      </main>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <ChatDock
        configured={health?.chatConfigured}
        officeId={allOffices ? "" : officeId}
        officeName={allOffices ? "" : selectedOffice?.name || pantry?.officeName || ""}
        month={month}
        onSaved={refresh}
      />
    </div>
  );
}

function Star() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 0 14.7 9.3 24 12 14.7 14.7 12 24 9.3 14.7 0 12 9.3 9.3Z" />
    </svg>
  );
}
