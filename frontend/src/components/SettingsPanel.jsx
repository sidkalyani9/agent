import { useEffect, useState } from "react";
import { api } from "../api.js";

export function SettingsPanel({ settings, onSaved, onToast }) {
  const [weight, setWeight] = useState(String(settings?.weekendWeight ?? 0.2));
  const [lookback, setLookback] = useState(String(settings?.lookbackMonths ?? 3));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setWeight(String(settings.weekendWeight));
    setLookback(String(settings.lookbackMonths));
  }, [settings]);

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api("/api/settings", {
        method: "PATCH",
        body: { weekendWeight: Number(weight), lookbackMonths: Number(lookback) },
      });
      setWeight(String(saved.weekendWeight));
      setLookback(String(saved.lookbackMonths));
      await onSaved?.();
      onToast?.("Settings saved.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card record-card">
      <h2>Settings</h2>
      <p className="lede">Weekend weight and lookback apply to every office. 0 closes weekends, 1 counts them as a full day.</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <form className="fields" onSubmit={save}>
        <label className="field">Lookback months
          <input inputMode="numeric" min="2" max="36" value={lookback} onChange={(event) => setLookback(event.target.value)} required />
        </label>
        <label className="field">Weekend weight
          <input inputMode="decimal" min="0" max="1" step="0.01" value={weight} onChange={(event) => setWeight(event.target.value)} required />
        </label>
        <p className="note">Lookback is a whole number from 2 to 36. Weekend weight is from 0 to 1.</p>
        <div className="field wide">
          <button className="solid" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </section>
  );
}
