import { useEffect, useState } from "react";
import { api, indiaDate, rupee } from "../api.js";
import { useFocusTrap } from "../focus.js";

export function Purchases({ officeId, month, revision, canWrite, onChanged, onToast }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const trap = useFocusTrap(Boolean(preview), () => closePreview());

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setRows(null);
    setError("");
    api(`/api/offices/${officeId}/purchases?month=${encodeURIComponent(month)}`)
      .then((data) => { if (!cancelled) setRows(data.purchases); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [open, officeId, month, revision]);

  useEffect(() => () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
  }, [preview]);

  function closePreview() {
    setPreview((current) => {
      if (current?.url) URL.revokeObjectURL(current.url);
      return null;
    });
  }

  async function loadReceipt(row) {
    const blob = await api(`/api/purchases/${row.purchaseId}/receipt`);
    return { blob, url: URL.createObjectURL(blob), type: blob.type || "application/pdf", name: row.receiptName || "receipt" };
  }

  async function openPreview(row) {
    setBusy(true);
    setError("");
    try {
      const next = await loadReceipt(row);
      setPreview(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function download(row) {
    setBusy(true);
    setError("");
    try {
      const next = await loadReceipt(row);
      const link = document.createElement("a");
      link.href = next.url;
      link.download = next.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(next.url), 1000);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function downloadPreview() {
    if (!preview) return;
    const link = document.createElement("a");
    link.href = preview.url;
    link.download = preview.name;
    link.click();
  }

  async function saveCorrection(event) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/purchases/${editing.purchaseId}`, {
        method: "PUT",
        body: { date: editing.date, packs: Number(editing.packs), pricePerPack: editing.price },
      });
      setEditing(null);
      onToast?.("Purchase corrected.");
      await onChanged?.();
      setRows(null);
      const data = await api(`/api/offices/${officeId}/purchases?month=${encodeURIComponent(month)}`);
      setRows(data.purchases);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removePurchase() {
    if (!removing) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/purchases/${removing.purchaseId}/delete`, { method: "POST", body: {} });
      setRemoving(null);
      onToast?.("Purchase removed.");
      await onChanged?.();
      const data = await api(`/api/offices/${officeId}/purchases?month=${encodeURIComponent(month)}`);
      setRows(data.purchases);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function attach(row, file) {
    if (!file) return;
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) {
      setError("A receipt is a PDF, JPEG, or PNG.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("A receipt is at most 10 MB.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const dataBase64 = await readBase64(file);
      await api(`/api/purchases/${row.purchaseId}/receipt`, {
        method: "PUT",
        body: { receipt: { fileName: file.name, contentType: file.type, dataBase64 } },
      });
      onToast?.("Receipt attached.");
      await onChanged?.();
      const data = await api(`/api/offices/${officeId}/purchases?month=${encodeURIComponent(month)}`);
      setRows(data.purchases);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="purchase-details" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Purchases and receipts</summary>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {open && !rows && !error ? <p className="note">Loading purchases.</p> : null}
      {rows?.length === 0 ? <p className="note">No purchases in this month.</p> : null}
      <div className="purchase-list">
        {rows?.map((row) => (
          <article className="purchase-row" key={row.purchaseId}>
            <div>
              <strong>{row.product}</strong>
              <p className="muted">{indiaDate(row.date)} · {row.packs} packs at {rupee(row.pricePerPack)}</p>
              <small className="muted">Entered by {row.enteredBy}</small>
              {row.receiptName ? <small className="muted">{row.receiptName}</small> : null}
            </div>
            <strong>{rupee(row.amount)}</strong>
            <div className="row-actions">
              {row.receiptName ? (
                <>
                  <button className="ghost" type="button" disabled={busy} onClick={() => openPreview(row)}>Preview receipt</button>
                  <button className="ghost" type="button" disabled={busy} onClick={() => download(row)}>Download receipt</button>
                </>
              ) : <span className="muted">No receipt</span>}
              {canWrite && !row.receiptName ? (
                <label className="ghost file-button">Attach receipt
                  <input className="sr-only" type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => attach(row, event.target.files?.[0])} />
                </label>
              ) : null}
              {canWrite ? <button className="ghost" type="button" onClick={() => { setRemoving(null); setEditing(editing?.purchaseId === row.purchaseId ? null : { ...row, price: row.pricePerPack }); }}>Correct</button> : null}
              {canWrite ? <button className="texty" type="button" onClick={() => { setEditing(null); setRemoving(row); }}>Remove</button> : null}
            </div>
            {editing?.purchaseId === row.purchaseId ? (
              <form className="fields purchase-edit" onSubmit={saveCorrection}>
                <label className="field">Date
                  <input type="date" value={editing.date} onChange={(event) => setEditing({ ...editing, date: event.target.value })} required />
                </label>
                <label className="field">Packs
                  <input inputMode="numeric" value={editing.packs} onChange={(event) => setEditing({ ...editing, packs: event.target.value })} required />
                </label>
                <label className="field">Price per pack (INR)
                  <input inputMode="decimal" value={editing.price} onChange={(event) => setEditing({ ...editing, price: event.target.value })} required />
                </label>
                <div className="field wide row-actions">
                  <button className="solid" type="submit" disabled={busy}>{busy ? "Saving…" : "Save correction"}</button>
                  <button className="ghost" type="button" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </form>
            ) : null}
            {removing?.purchaseId === row.purchaseId ? (
              <div className="confirm-card">
                <p>Remove this purchase of {row.packs} packs of {row.product} on {indiaDate(row.date)}? This deletes it.</p>
                <div className="row-actions">
                  <button className="solid" type="button" disabled={busy} onClick={removePurchase}>Remove purchase</button>
                  <button className="ghost" type="button" onClick={() => setRemoving(null)}>Keep</button>
                </div>
              </div>
            ) : null}
          </article>
        ))}
      </div>
      {preview ? (
        <div className="modal-back" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label={preview.name} ref={trap} tabIndex={-1}>
            <div className="card-head">
              <h2>{preview.name}</h2>
              <div className="row-actions">
                <button className="ghost" type="button" onClick={downloadPreview}>Download receipt</button>
                <button className="ghost" type="button" onClick={closePreview}>Close</button>
              </div>
            </div>
            {preview.type.startsWith("image/") ? <img className="receipt-preview" src={preview.url} alt={preview.name} /> : <iframe className="receipt-frame" title={preview.name} src={preview.url} />}
          </div>
        </div>
      ) : null}
    </details>
  );
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("That file could not be read."));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}
