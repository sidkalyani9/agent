import { useEffect, useState } from "react";
import { api, indiaDate, rupee } from "../api.js";

export function Purchases({ officeId, month, revision }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState("");
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRows(null); setError("");
    api(`/api/offices/${officeId}/purchases?month=${encodeURIComponent(month)}`)
      .then(data => { if (!cancelled) setRows(data.purchases); })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [open, officeId, month, revision]);
  async function download(row) {
    setDownloading(row.purchaseId); setError("");
    try {
      const blob = await api(`/api/purchases/${row.purchaseId}/receipt`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = row.receiptName || "receipt";
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { setError(err.message); }
    finally { setDownloading(""); }
  }
  return <details className="purchase-details" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Purchases and receipts</summary>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {open && !rows && !error ? <p className="note">Loading purchases.</p> : null}
    {rows?.length === 0 ? <p className="note">No purchases in this month.</p> : null}
    <div className="purchase-list">{rows?.map(row => <article className="purchase-row" key={row.purchaseId}>
      <div><strong>{row.product}</strong><p className="muted">{indiaDate(row.date)} · {row.packs} packs at {rupee(row.pricePerPack)}</p><small className="muted">Entered by {row.enteredBy}</small></div>
      <strong>{rupee(row.amount)}</strong>
      {row.receiptName ? <button className="ghost" onClick={() => download(row)} disabled={Boolean(downloading)}>
        {downloading === row.purchaseId ? "Downloading…" : "Download receipt"}
      </button> : <span className="muted">No receipt</span>}
    </article>)}</div>
  </details>;
}
